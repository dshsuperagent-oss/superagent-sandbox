# observador.ps1 - observador permanente do DSH diario (porta 3080).
#
# Roda FORA da arvore do DSH (Startup do usuario), sem admin.
# Grava em <DataDir>\observacao\:
#   snapshot-YYYY-MM-DD.jsonl       (2 s)  saude do alvo + HTTP + conexoes
#   processos-YYYY-MM-DD.jsonl      (100 ms, diff) processos novos/que sairam
#   eventos-YYYY-MM-DD.jsonl        (30 s) Event Log System/Application/TaskScheduler
#   hash-sessoes-YYYY-MM-DD.jsonl   (30 s) mtime/tamanho (hash parcial quando muda)
#   veredito-YYYYMMDD-HHmmss.json   (na queda) classificacao + evidencias
#   estado.json                     (5 s)  heartbeat do observador
#
# NUNCA reinicia nem encerra o DSH. Quem sobe servidor morto e o watchdog-3080.ps1.

[CmdletBinding()]
param(
    [string]$DataDir = 'F:\ai\_lab\dsh-saude\observador',
    [int]$Port = 3080,
    [int]$TargetPid = 0,
    [int]$SnapshotSec = 2,
    [int]$ProcessPollMs = 100,
    [int]$EventSec = 30,
    [int]$SessionSec = 30,
    [int]$HeartbeatSec = 5,
    [int]$RetentionDays = 7,
    [int]$DurationSeconds = 0,
    [string]$ForceDate = '',
    [ValidateSet('curl', 'dotnet', 'none')]
    [string]$HttpProbe = 'curl',
    [int]$TrimSec = 60,
    [switch]$NoEvents,
    [switch]$NoSessions
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'lib.ps1')

$Versao = '1.0'
$ObsDir = Join-Path $DataDir 'observacao'
$LogDir = Join-Path $DataDir 'logs'
foreach ($d in @($DataDir, $ObsDir, $LogDir)) {
    if (-not (Test-Path -LiteralPath $d)) { $null = New-Item -ItemType Directory -Force -Path $d }
}

# Instancia unica por DataDir (Global; Local como fallback em sandbox restrito).
$mutex = New-InstanceMutex (Get-ObserverMutexName $DataDir)
if ($null -eq $mutex) {
    $mutex = New-InstanceMutex ('Local\' + (Get-ObserverMutexName $DataDir))
}
if ($null -eq $mutex) {
    Write-PlainLog $LogDir 'observador' ('outra instancia ja roda para ' + $DataDir + '; saindo')
    exit 0
}

$script:Iniciado = Get-Date
$script:Ciclos = 0
$script:Erros = 0
$script:Amostras = @{ snapshot = 0; processos = 0; eventos = 0; sessoes = 0; vereditos = 0; lacunas = 0 }
$script:LastProcPoll = (Get-Date).AddDays(-1)
$script:ProcMap = @{}
$script:ProcCache = @{}
$script:Bootstrapped = $false
$script:LastTrim = $null
$script:RecentProc = New-Object System.Collections.ArrayList
$script:RecentSnap = New-Object System.Collections.ArrayList
$script:LastChildAt = (Get-Date).AddDays(-1)
$script:EventMaxId = @{}
$script:SessionMeta = @{}
$script:HttpFailSince = $null
$script:HungVerdictDone = $false
$script:LastVerdictPid = 0
$script:LastVerdictAt = $null
$script:LastPortInfo = $null

$script:RxSuspect = '(?i)(taskkill|stop-process|restart-dsh|dsh-diario|watchdog-3080|supervisor-dsh|\b3080\b|/PID\s+\d+|pkill)'
$script:SuspectNames = @('taskkill.exe', 'taskkill', 'powershell.exe', 'powershell', 'pwsh.exe', 'pwsh', 'cmd.exe', 'cmd', 'wmic.exe', 'taskmgr.exe', 'procexp.exe', 'procexp64.exe', 'processhacker.exe', 'psexec.exe', 'schtasks.exe', 'node.exe', 'node')

$target = @{
    pid       = 0
    alive     = $false
    start     = $null
    name      = $null
    adopted_at = $null
    fixed     = ($TargetPid -gt 0)
    miss      = 0
}

function Get-DataDay {
    if ($ForceDate) {
        try { return [datetime]::ParseExact($ForceDate, 'yyyy-MM-dd', $null) } catch { }
    }
    return (Get-Date).Date
}

function Get-ProcessStartSafe([int]$ProcId) {
    try {
        $p = Get-Process -Id $ProcId -ErrorAction Stop
        try { return $p.StartTime.ToString('o') } finally { $p.Dispose() }
    } catch { return $null }
}

# Alvo vivo? Nao confiar so no mapa de processos: em sandbox/profile restrito o
# observador pode nao enxergar um processo de outra integridade. A porta com
# dono = PID do alvo tambem prova vida.
function Test-TargetAlive {
    if ($target.pid -le 0) { return $false }
    if ($script:ProcMap.ContainsKey([int]$target.pid)) { return $true }
    if (Test-ProcessAlive $target.pid) { return $true }
    if ($null -ne $script:LastPortInfo -and $script:LastPortInfo.listen -and [int]$script:LastPortInfo.owner_pid -eq [int]$target.pid) { return $true }
    return $false
}

function Get-TargetMetrics {
    if ($target.pid -le 0) { return $null }
    try {
        $p = Get-Process -Id $target.pid -ErrorAction Stop
        try {
            return [pscustomobject]@{
                cpu_s   = [math]::Round($p.TotalProcessorTime.TotalSeconds, 2)
                rss_mb  = [math]::Round($p.WorkingSet64 / 1MB, 1)
                handles = $p.Handles
                threads = $p.Threads.Count
            }
        } finally { $p.Dispose() }
    } catch { return $null }
}

function Add-RecentProc($Record, [int]$Line, [string]$File) {
    $item = [pscustomobject]@{
        ts      = $Record.ts
        event   = $Record.event
        pid     = $Record.pid
        ppid    = $Record.ppid
        name    = $Record.name
        cmdline = $Record.cmdline
        suspect = $Record.suspect
        reasons = $Record.reasons
        ancestors = $Record.ancestors
        alvo_vivo_no_fim = $Record.alvo_vivo_no_fim
        line    = $Line
        file    = $File
    }
    $null = $script:RecentProc.Add($item)
    while ($script:RecentProc.Count -gt 250) { $script:RecentProc.RemoveAt(0) }
}

function Get-SuspectInfo([int]$ProcId, [string]$Name, [string]$Cmdline, $Ancestors) {
    $reasons = New-Object System.Collections.ArrayList
    $nm = ''
    if ($Name) { $nm = $Name.ToLowerInvariant() }
    if ($script:SuspectNames -contains $nm) { $null = $reasons.Add('nome:' + $nm) }
    if ($Cmdline -and ($Cmdline -match $script:RxSuspect)) { $null = $reasons.Add('cmdline_suspeita') }
    if ($target.pid -gt 0 -and $Cmdline) {
        if ($Cmdline -match ('(?<!\d)' + [string]$target.pid + '(?!\d)')) { $null = $reasons.Add('menciona_pid_alvo') }
    }
    if ($null -ne $Ancestors) {
        foreach ($a in $Ancestors) {
            if ($a.pid -eq $target.pid) { $null = $reasons.Add('descendente_do_alvo'); break }
        }
    }
    return [pscustomobject]@{ suspect = ($reasons.Count -gt 0); reasons = $reasons.ToArray() }
}

function Invoke-ProcPoll {
    # Snapshot de PIDs/PPIDs sem alocar objeto Process por processo (barato).
    $pairs = @(Get-ProcessIdPairs)
    $nowMap = @{}
    $nowPpid = @{}
    for ($i = 0; $i -lt $pairs.Count; $i += 2) {
        $childPid = [int]$pairs[$i]
        if ($childPid -le 0) { continue }
        $nowMap[$childPid] = $true
        $nowPpid[$childPid] = [int]$pairs[$i + 1]
    }
    $prev = $script:ProcMap
    $day = Get-DataDay
    $fileName = 'processos-' + $day.ToString('yyyy-MM-dd') + '.jsonl'

    # Primeiro ciclo: baseline barata. No inicio NAO existe "processo novo": tratar
    # todos os processos como novos custava ~15-22 s (Get-Process + PEB + cadeia de
    # ancestrais por processo) e atrasava o primeiro heartbeat. Aqui so guardamos os
    # PIDs/PPIDs da API nativa (NtQuerySystemInformation) e gravamos UM resumo,
    # sem cmdline de todos.
    if (-not $script:Bootstrapped) {
        $script:ProcMap = $nowMap
        $script:Bootstrapped = $true
        $script:LastProcPoll = Get-Date
        if ($target.pid -gt 0) { $target.alive = $nowMap.ContainsKey([int]$target.pid) }
        $rec = [pscustomobject]@{
            ts         = Get-IsoNow
            event      = 'baseline'
            count      = $nowMap.Count
            target_pid = $target.pid
            alvo_vivo  = $target.alive
            fonte      = 'nqsi'
            detalhe    = 'primeiro ciclo: PIDs/PPIDs pela API nativa; sem PEB/cmdline por processo'
        }
        $null = Add-JsonlRecord $ObsDir 'processos' $rec $day
        Write-PlainLog $LogDir 'observador' ('baseline: ' + $nowMap.Count + ' processos (sem PEB); alvo_vivo=' + $target.alive)
        return
    }

    # Processos novos
    foreach ($k in @($nowMap.Keys)) {
        if ($prev.ContainsKey($k)) { continue }
        if ($k -eq $PID) { continue }
        $name = $null
        try {
            $gp = Get-Process -Id $k -ErrorAction Stop
            try { $name = [string]$gp.ProcessName } finally { $gp.Dispose() }
        } catch { $name = '?' }
        $ppid = 0
        if ($nowPpid.ContainsKey($k)) { $ppid = [int]$nowPpid[$k] }
        $detail = Get-ProcessDetail $k $name
        if ($detail.ppid -gt 0) { $ppid = [int]$detail.ppid }
        # Filhos do proprio observador (curl/netstat) nao entram no log.
        if ($ppid -eq $PID) { continue }
        if ($ppid -le 0 -and $name -match '^(?i)(curl|netstat)$') {
            $age = ((Get-Date) - $script:LastChildAt).TotalSeconds
            if ($age -lt 2) { continue }
        }
        $anc = @(Get-AncestorChain $ppid 6 $nowPpid)
        $s = Get-SuspectInfo $k $name $detail.cmdline $anc
        $start = Get-ProcessStartSafe $k
        $rec = [pscustomobject]@{
            ts         = Get-IsoNow
            event      = 'start'
            pid        = $k
            ppid       = $ppid
            name       = $name
            cmdline    = (Truncate-Text $detail.cmdline 1500)
            start      = $start
            ancestors  = $anc
            suspect    = $s.suspect
            reasons    = $s.reasons
            target_pid = $target.pid
            fonte      = $detail.fonte
            error      = $detail.error
        }
        $line = Add-JsonlRecord $ObsDir 'processos' $rec $day
        $script:Amostras.processos = [int]$script:Amostras.processos + 1
        Add-RecentProc $rec $line $fileName
        $script:ProcCache[$k] = $rec
        if ($target.pid -gt 0 -and $k -eq $target.pid) {
            $target.alive = $true
            if (-not $target.start) { $target.start = $start }
        }
    }

    # Processos que sairam
    foreach ($k in @($prev.Keys)) {
        if ($nowMap.ContainsKey($k)) { continue }
        $info = $script:ProcCache[$k]
        if ($null -eq $info) { continue }
        $lifetime = $null
        if ($info.start) {
            try { $lifetime = [math]::Round(((Get-Date) - [datetime]::Parse($info.start)).TotalMilliseconds, 0) } catch { }
        }
        $rec = [pscustomobject]@{
            ts          = Get-IsoNow
            event       = 'exit'
            pid         = $k
            ppid        = $info.ppid
            name        = $info.name
            cmdline     = $info.cmdline
            start       = $info.start
            lifetime_ms = $lifetime
            ancestors   = $info.ancestors
            suspect     = $info.suspect
            reasons     = $info.reasons
            target_pid  = $target.pid
            alvo_vivo_no_fim = ($target.pid -gt 0 -and $nowMap.ContainsKey([int]$target.pid))
        }
        $line = Add-JsonlRecord $ObsDir 'processos' $rec $day
        $script:Amostras.processos = [int]$script:Amostras.processos + 1
        Add-RecentProc $rec $line $fileName
        # O cache serve so para montar o registro de saida; descarta ao sair para
        # nao crescer por dias.
        $script:ProcCache.Remove($k)
    }

    $script:ProcMap = $nowMap
    $script:LastProcPoll = Get-Date

    # Morte do alvo: exige 3 leituras negativas e confirmacao fresca da porta,
    # para nao gerar falso veredito quando o processo nao e visivel ao sandbox.
    if ($target.pid -gt 0 -and $target.alive) {
        if (Test-TargetAlive) {
            $target.miss = 0
        } else {
            $target.miss = [int]$target.miss + 1
            if ($target.miss -ge 3) {
                $confirm = Get-PortInfo $Port
                if ($confirm.listen -and [int]$confirm.owner_pid -eq [int]$target.pid) {
                    $target.miss = 0
                } else {
                    New-Verdict -Causa 'processo_alvo_desapareceu' -VictimPid ([int]$target.pid)
                    $target.alive = $false
                    $target.pid = 0
                    $target.start = $null
                    $target.name = $null
                    $target.miss = 0
                }
            }
        }
    }
}

function Invoke-Snapshot {
    $day = Get-DataDay
    $portInfo = Get-PortInfo $Port
    $script:LastPortInfo = $portInfo

    # Adocao do alvo quando nao foi passado -TargetPid.
    if (-not $target.fixed -and $target.pid -le 0 -and $portInfo.listen -and $portInfo.owner_pid -gt 0) {
        $target.pid = [int]$portInfo.owner_pid
        $target.alive = $true
        $target.start = Get-ProcessStartSafe $target.pid
        $target.name = $null
        try {
            $tp = Get-Process -Id $target.pid -ErrorAction Stop
            try { $target.name = [string]$tp.ProcessName } finally { $tp.Dispose() }
        } catch { }
        $target.adopted_at = Get-IsoNow
        $rec = [pscustomobject]@{
            ts         = Get-IsoNow
            event      = 'target_adopted'
            pid        = $target.pid
            ppid       = 0
            name       = $target.name
            cmdline    = $null
            start      = $target.start
            ancestors  = @()
            suspect    = $false
            reasons    = @('dono_da_porta')
            target_pid = $target.pid
        }
        $line = Add-JsonlRecord $ObsDir 'processos' $rec $day
        Add-RecentProc $rec $line ('processos-' + $day.ToString('yyyy-MM-dd') + '.jsonl')
        $script:ProcCache[[int]$target.pid] = $rec
        Write-PlainLog $LogDir 'observador' ('alvo adotado: pid ' + $target.pid + ' na porta ' + $Port)
    }

    $http = [pscustomobject]@{ code = 'n/a'; ms = 0 }
    if ($HttpProbe -eq 'curl' -or $HttpProbe -eq 'dotnet') {
        $script:LastChildAt = Get-Date
        if ($HttpProbe -eq 'curl') {
            $http = Invoke-HttpProbe $Port
        } else {
            $http = Invoke-HttpProbe-DotNet $Port
        }
    }

    $metrics = Get-TargetMetrics
    $alive = Test-TargetAlive
    if ($target.pid -gt 0 -and -not $target.start) { $target.start = Get-ProcessStartSafe $target.pid }

    $rec = [pscustomobject]@{
        ts       = Get-IsoNow
        obs_pid  = $PID
        target   = [pscustomobject]@{
            pid     = $target.pid
            alive   = $alive
            start   = $target.start
            cpu_s   = $(if ($metrics) { $metrics.cpu_s } else { $null })
            rss_mb  = $(if ($metrics) { $metrics.rss_mb } else { $null })
            handles = $(if ($metrics) { $metrics.handles } else { $null })
            threads = $(if ($metrics) { $metrics.threads } else { $null })
        }
        port     = $Port
        listen   = $portInfo.listen
        owner_pid = $portInfo.owner_pid
        http     = [pscustomobject]@{ code = $http.code; ms = $http.ms }
        conn     = $portInfo.states
        uptime_s = [math]::Round(((Get-Date) - $script:Iniciado).TotalSeconds, 0)
    }
    $line = Add-JsonlRecord $ObsDir 'snapshot' $rec $day
    $script:Amostras.snapshot = [int]$script:Amostras.snapshot + 1
    $snap = [pscustomobject]@{ ts = $rec.ts; line = $line; file = ('snapshot-' + $day.ToString('yyyy-MM-dd') + '.jsonl'); record = $rec }
    $null = $script:RecentSnap.Add($snap)
    while ($script:RecentSnap.Count -gt 15) { $script:RecentSnap.RemoveAt(0) }

    # Deteccao de "hung": porta aberta, alvo vivo, HTTP sem resposta > 20 s.
    if ($alive -and $portInfo.listen -and $HttpProbe -ne 'none' -and $http.code -eq '000') {
        if ($null -eq $script:HttpFailSince) { $script:HttpFailSince = Get-Date }
        $hangSec = ((Get-Date) - $script:HttpFailSince).TotalSeconds
        if ($hangSec -ge 20 -and -not $script:HungVerdictDone) {
            New-Verdict -Causa 'hung_http_sem_resposta' -VictimPid ([int]$target.pid)
            $script:HungVerdictDone = $true
        }
    } else {
        $script:HttpFailSince = $null
        if ($http.code -ne '000') { $script:HungVerdictDone = $false }
    }
}

function Invoke-HttpProbe-DotNet([int]$Porta) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $code = '000'
    try {
        $req = [System.Net.HttpWebRequest]::Create(("http://127.0.0.1:{0}/" -f $Porta))
        $req.Timeout = 4000
        $req.Proxy = $null
        $resp = $req.GetResponse()
        $code = [string][int]$resp.StatusCode
        $resp.Close()
    } catch {
        if ($null -ne $_.Exception.Response) {
            try { $code = [string][int]$_.Exception.Response.StatusCode } catch { $code = '000' }
        } else { $code = '000' }
    }
    $sw.Stop()
    return [pscustomobject]@{ code = $code; ms = [math]::Round($sw.Elapsed.TotalMilliseconds, 1) }
}

function Invoke-Events {
    $day = Get-DataDay
    $since = (Get-Date).AddSeconds(-1 * $EventSec)
    $evs = @(Get-RelevantEvents $since 80)
    $novos = 0
    foreach ($ev in $evs) {
        $logKey = [string]$ev.log
        $maxId = 0
        if ($script:EventMaxId.ContainsKey($logKey)) { $maxId = [int]$script:EventMaxId[$logKey] }
        if ($ev.id -eq 0) {
            # erro de leitura: grava no maximo 1 vez por hora
            if ($script:EventMaxId.ContainsKey($logKey + ':erro') -and ((Get-Date) - $script:EventMaxId[$logKey + ':erro']).TotalMinutes -lt 60) { continue }
            $script:EventMaxId[$logKey + ':erro'] = Get-Date
        } elseif ([long]$ev.record_id -le $maxId) {
            continue
        } else {
            $script:EventMaxId[$logKey] = [long]$ev.record_id
        }
        $line = Add-JsonlRecord $ObsDir 'eventos' $ev $day
        $novos++
    }
    if ($novos -gt 0) { $script:Amostras.eventos = [int]$script:Amostras.eventos + $novos }
}

function Invoke-Sessions {
    $day = Get-DataDay
    $sessions = @(Get-SessionSnapshot)
    $changed = New-Object System.Collections.ArrayList
    foreach ($s in $sessions) {
        $old = $script:SessionMeta[$s.path]
        if ($null -eq $old -or $old.mtime -ne $s.mtime -or $old.size -ne $s.size) {
            $s.quick_hash = Get-QuickHash $s.path
            $null = $changed.Add($s)
            $script:SessionMeta[$s.path] = $s
        }
    }
    $rec = [pscustomobject]@{
        ts      = Get-IsoNow
        count   = $sessions.Count
        changed = $changed.ToArray()
    }
    $null = Add-JsonlRecord $ObsDir 'hash-sessoes' $rec $day
    if ($changed.Count -gt 0) { $script:Amostras.sessoes = [int]$script:Amostras.sessoes + $changed.Count }
}

function New-Evidence([string]$Fonte, [int]$Linha, [string]$Hora, $Trecho) {
    $txt = ''
    try { $txt = ($Trecho | ConvertTo-Json -Compress -Depth 8) } catch { $txt = [string]$Trecho }
    return [pscustomobject]@{
        fonte  = $Fonte
        linha  = $Linha
        hora   = $Hora
        trecho = (Truncate-Text $txt 450)
    }
}

function Find-Killer([datetime]$Since, [int]$VictimPid) {
    $best = $null
    $bestScore = -1
    foreach ($r in $script:RecentProc) {
        $when = $null
        try { $when = [datetime]::Parse([string]$r.ts) } catch { $when = $null }
        if ($null -eq $when -or $when -lt $Since) { continue }
        if (-not $r.suspect) { continue }
        # taskkill/Stop-Process que saiu com o alvo ainda vivo NAO matou: nao citar.
        if ($r.alvo_vivo_no_fim -eq $true) { continue }
        $score = 0
        $nm = ''
        if ($r.name) { $nm = $r.name.ToLowerInvariant() }
        if ($nm -match 'taskkill') { $score += 5 }
        if ($r.cmdline -and ($r.cmdline -match ('(?<!\d)' + [string]$VictimPid + '(?!\d)'))) { $score += 6 }
        if ($r.cmdline -and ($r.cmdline -match '(?i)(stop-process|taskkill|kill)')) { $score += 3 }
        if ($r.event -eq 'exit' -and $nm -match 'taskkill') { $score += 1 }
        if ($score -gt $bestScore) {
            $bestScore = $score
            $best = [pscustomobject]@{ record = $r; score = $score }
        }
    }
    if ($null -ne $best -and $best.score -ge 8) { return $best }
    return $null
}

function New-Verdict([string]$Causa, [int]$VictimPid) {
    if ($VictimPid -le 0) { return }
    if ($script:LastVerdictPid -eq $VictimPid -and $null -ne $script:LastVerdictAt -and ((Get-Date) - $script:LastVerdictAt).TotalSeconds -lt 10) { return }

    $agora = Get-Date
    $since = $agora.AddSeconds(-30)
    $evid = New-Object System.Collections.ArrayList
    $timeline = New-Object System.Collections.ArrayList

    $killer = Find-Killer $since $VictimPid
    $sup = Get-SupervisorExitInfo $LogDir $VictimPid $since
    $consoleTail = @(Get-ConsoleTail (Join-Path $LogDir 'dsh-console-timestamped.log') 80)
    $stack = Test-StackSignature $consoleTail
    $evs = @(Get-RelevantEvents $since 40)

    $cls = 'unknown'
    $conf = 'baixa'
    $resumo = ''
    $killerObj = $null
    $limit = New-Object System.Collections.ArrayList

    if ($null -ne $killer) {
        $killerObj = [pscustomobject]@{
            pid       = $killer.record.pid
            ppid      = $killer.record.ppid
            nome      = $killer.record.name
            cmdline   = $killer.record.cmdline
            ancestrais = $killer.record.ancestors
            fonte     = $killer.record.file
            linha     = $killer.record.line
        }
        $cls = 'killed'
        if ($killer.score -ge 12) { $conf = 'alta' } elseif ($killer.score -ge 8) { $conf = 'media' } else { $conf = 'baixa' }
        $resumo = ('Encerrado por ' + $killer.record.name + ' (pid ' + $killer.record.pid + ', pai ' + $killer.record.ppid + '): ' + (Truncate-Text $killer.record.cmdline 180))
        $null = $evid.Add((New-Evidence $killer.record.file $killer.record.line $killer.record.ts $killer.record))
        $null = $timeline.Add([pscustomobject]@{ hora = $killer.record.ts; evento = 'assassino'; detalhe = ($killer.record.name + ' pid=' + $killer.record.pid + ' cmd=' + (Truncate-Text $killer.record.cmdline 160)) })
    } else {
        if ($null -ne $sup) {
            $ec = [int]$sup.exit_code
            if ($stack) {
                $cls = 'crashed'
                $conf = 'media'
                $resumo = ('Saiu com exit code ' + $ec + ' e stderr com assinatura de erro/stack; provavel crash.')
            } elseif ($ec -ne 0) {
                $cls = 'killed'
                $conf = 'media'
                $resumo = ('Saiu com exit code ' + $ec + ' sem taskkill observado e sem stack: encerrado externamente (autor nao identificado).')
                $null = $limit.Add('exit code != 0 sem stack nao distingue encerramento externo de crash silencioso.')
            } else {
                $cls = 'unknown'
                $conf = 'baixa'
                $resumo = 'Saiu com exit code 0; sem assinatura suficiente.'
            }
            $null = $evid.Add((New-Evidence ('logs\' + [string]$sup.fonte) 0 ([string]$sup.ts) $sup))
            $null = $timeline.Add([pscustomobject]@{ hora = [string]$sup.ts; evento = 'supervisor_exit'; detalhe = ('exit_code=' + $ec) })
        } elseif ($stack) {
            $cls = 'crashed'
            $conf = 'baixa'
            $resumo = 'Sem taskkill e sem supervisor; console com assinatura de erro/stack sugere crash.'
        } else {
            $resumo = 'Dados insuficientes para atribuir autoria.'
        }
    }

    if ($stack) { $null = $limit.Add('stack no console (ultimas linhas) pode ser de reinicializacao posterior, nao necessariamente da queda.') }

    # Veredito de hang tem prioridade sobre a classificacao por exit (o processo
    # pode continuar vivo; o sintoma e a porta aberta sem resposta).
    if ($Causa -eq 'hung_http_sem_resposta') {
        $cls = 'hung'
        $conf = 'alta'
        $resumo = ('Porta ' + $Port + ' em LISTEN com o alvo (pid ' + $VictimPid + ') vivo, mas HTTP / sem resposta por mais de 20 s.')
        $null = $limit.Add('hung nao prova causa: pode ser bloqueio do event loop, GC, disco ou rede; o processo nao foi encerrado pelo observador.')
    }

    # Evidencias de snapshot e eventos relevantes.
    foreach ($s in @($script:RecentSnap | Select-Object -Last 3)) {
        $null = $evid.Add((New-Evidence $s.file $s.line $s.ts $s.record))
        $null = $timeline.Add([pscustomobject]@{ hora = $s.ts; evento = 'snapshot'; detalhe = ('listen=' + $s.record.listen + ' http=' + $s.record.http.code + ' alive=' + $s.record.target.alive) })
    }
    $evidCount = 0
    foreach ($ev in $evs) {
        if ($evidCount -ge 8) { break }
        $rel = ($ev.id -in @(41, 1000, 1001, 1002, 6008, 7031, 7034)) -or ($ev.log -like '*TaskScheduler*')
        if (-not $rel) { continue }
        $null = $evid.Add((New-Evidence ('logs\eventos (Event Log ' + $ev.log + ')') 0 $ev.time $ev))
        $null = $timeline.Add([pscustomobject]@{ hora = $ev.time; evento = ('eventlog:' + $ev.log + ':' + $ev.id); detalhe = (Truncate-Text $ev.message 160) })
        $evidCount++
    }

    # Evidencia do processo alvo (start/exit).
    $alvoEvid = 0
    foreach ($r in $script:RecentProc) {
        if ($r.pid -ne $VictimPid) { continue }
        if ($alvoEvid -ge 2) { break }
        $null = $evid.Add((New-Evidence $r.file $r.line $r.ts $r))
        $null = $timeline.Add([pscustomobject]@{ hora = $r.ts; evento = ('alvo_' + $r.event); detalhe = (Truncate-Text $r.cmdline 160) })
        $alvoEvid++
    }

    $null = $limit.Add('Sem admin nao ha ETW/WMI process events/4688: processos com vida menor que o intervalo de poll (' + $ProcessPollMs + ' ms) podem escapar.')
    $null = $limit.Add('CommandLine/PPID vem do PEB do processo alvo; outro usuario/integridade pode negar leitura (error OpenProcess:5).')

    $veredito = [pscustomobject]@{
        versao      = $Versao
        veredito    = $cls
        confianca   = $conf
        gerado_em   = (Get-IsoNow)
        causa       = $Causa
        alvo        = [pscustomobject]@{
            pid      = $VictimPid
            nome     = $target.name
            start    = $target.start
            porta    = $Port
            fixado   = $target.fixed
        }
        resumo      = $resumo
        assassino   = $killerObj
        evidencias  = $evid.ToArray()
        timeline    = $timeline.ToArray()
        limitacoes  = $limit.ToArray()
    }

    $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
    $path = Join-Path $ObsDir ('veredito-' + $stamp + '.json')
    $i = 1
    while (Test-Path -LiteralPath $path) {
        $path = Join-Path $ObsDir ('veredito-' + $stamp + '-' + $i + '.json')
        $i++
    }
    Write-JsonFile $path $veredito
    $script:Amostras.vereditos = [int]$script:Amostras.vereditos + 1
    $script:LastVerdictPid = $VictimPid
    $script:LastVerdictAt = Get-Date
    Write-PlainLog $LogDir 'observador' ('veredito ' + $cls + ' (' + $conf + ') para pid ' + $VictimPid + ' -> ' + $path)
}

function Write-Heartbeat {
    $day = Get-DataDay
    $estado = [pscustomobject]@{
        versao          = $Versao
        pid             = $PID
        iniciado        = $script:Iniciado.ToString('o')
        ultimo_ciclo    = (Get-IsoNow)
        alvo_pid        = $target.pid
        alvo_iniciado   = $target.start
        alvo_fixado     = $target.fixed
        porta           = $Port
        data_dir        = $DataDir
        observacao_dir  = $ObsDir
        ciclos          = $script:Ciclos
        erros           = $script:Erros
        amostras        = $script:Amostras
        http_probe      = $HttpProbe
        retencao_dias   = $RetentionDays
        force_date      = $ForceDate
        mem_priv_mb     = $(try { [math]::Round([System.Diagnostics.Process]::GetCurrentProcess().PrivateMemorySize64 / 1MB, 1) } catch { $null })
        gc_mb           = $(try { [math]::Round([System.GC]::GetTotalMemory($false) / 1MB, 1) } catch { $null })
        ultimo_trim     = $script:LastTrim
    }
    Write-JsonFile (Join-Path $ObsDir 'estado.json') $estado
}

function Invoke-Cleanup {
    $day = Get-DataDay
    $n1 = Remove-OldObservationFiles $ObsDir $day $RetentionDays
    Remove-OldLogFiles $LogDir $day $RetentionDays
    if ($n1 -gt 0) { Write-PlainLog $LogDir 'observador' ('retencao removeu ' + $n1 + ' arquivo(s) de observacao') }
}

# ---------------------------------------------------------------------------
# Inicio
# ---------------------------------------------------------------------------

Write-PlainLog $LogDir 'observador' ('iniciado pid=' + $PID + ' data_dir=' + $DataDir + ' porta=' + $Port + ' target=' + $TargetPid + ' poll_ms=' + $ProcessPollMs + ' http=' + $HttpProbe)

if ($TargetPid -gt 0) {
    $target.pid = $TargetPid
    $target.start = Get-ProcessStartSafe $TargetPid
    $target.alive = ($null -ne $target.start)
    try {
        $tp = Get-Process -Id $TargetPid -ErrorAction Stop
        try {
            $target.name = [string]$tp.ProcessName
            if ($null -eq $target.start) { $target.start = $tp.StartTime.ToString('o') }
        } finally { $tp.Dispose() }
    } catch { }
    Write-PlainLog $LogDir 'observador' ('alvo fixado por parametro: pid ' + $TargetPid + ' nome=' + $target.name)
}

# Heartbeat inicial ANTES de qualquer varredura cara (diff de processos/PEB,
# snapshot, eventos, sessoes). Se o DSH morrer durante o boot, ja existe registro
# de que o observador estava vivo, qual alvo seguia e quando iniciou.
Write-Heartbeat

# Registro inicial em cada categoria (garante arquivo existente para prova/teste).
$day0 = Get-DataDay
$null = Add-JsonlRecord $ObsDir 'eventos' ([pscustomobject]@{
    ts        = Get-IsoNow
    log       = 'observador'
    id        = 0
    level     = 'info'
    provider  = 'dsh-maintenance'
    time      = Get-IsoNow
    record_id = 0
    message   = 'observador iniciado; coletando Event Log System/Application/TaskScheduler'
}) $day0
$null = Add-JsonlRecord $ObsDir 'hash-sessoes' ([pscustomobject]@{
    ts      = Get-IsoNow
    count   = 0
    changed = @()
}) $day0

# Alvo fixado por parametro: UM registro, sem PEB.
if ($TargetPid -gt 0) {
    $recT = [pscustomobject]@{
        ts         = Get-IsoNow
        event      = 'target_fixed'
        pid        = $target.pid
        ppid       = 0
        name       = $target.name
        cmdline    = $null
        start      = $target.start
        ancestors  = @()
        suspect    = $false
        reasons    = @('parametro_targetpid')
        target_pid = $target.pid
        fonte      = 'parametro'
        error      = $null
    }
    $lineT = Add-JsonlRecord $ObsDir 'processos' $recT $day0
    Add-RecentProc $recT $lineT ('processos-' + $day0.ToString('yyyy-MM-dd') + '.jsonl')
    # O alvo entra no cache para o registro de saida (name/start ja conhecidos).
    $script:ProcCache[[int]$target.pid] = $recT
}

Invoke-Cleanup
# Libera o working set ja no startup (o primeiro poll ainda vai alocar um pouco).
Trim-ObserverMemory
$script:LastTrim = Get-IsoNow
$nextSnapshot = Get-Date
$nextEvent = (Get-Date).AddSeconds(2)
$nextSession = (Get-Date).AddSeconds(3)
$nextHeartbeat = (Get-Date).AddSeconds($HeartbeatSec)
$nextCleanup = (Get-Date).AddMinutes(10)
$nextTrim = (Get-Date).AddSeconds(15)
$script:LastProcPoll = (Get-Date).AddDays(-1)

try {
    while ($true) {
        if ($DurationSeconds -gt 0 -and ((Get-Date) - $script:Iniciado).TotalSeconds -ge $DurationSeconds) { break }
        $now = Get-Date
        $script:Ciclos = [int]$script:Ciclos + 1
        try {
            if (($now - $script:LastProcPoll).TotalMilliseconds -ge $ProcessPollMs) {
                Invoke-ProcPoll
            }
            if ($now -ge $nextSnapshot) {
                Invoke-Snapshot
                $nextSnapshot = (Get-Date).AddSeconds($SnapshotSec)
            }
            if ($now -ge $nextEvent -and -not $NoEvents) {
                Invoke-Events
                $nextEvent = (Get-Date).AddSeconds($EventSec)
            }
            if ($now -ge $nextSession -and -not $NoSessions) {
                Invoke-Sessions
                $nextSession = (Get-Date).AddSeconds($SessionSec)
            }
            if ($now -ge $nextHeartbeat) {
                Write-Heartbeat
                $nextHeartbeat = (Get-Date).AddSeconds($HeartbeatSec)
            }
            if ($now -ge $nextCleanup) {
                Invoke-Cleanup
                $nextCleanup = (Get-Date).AddMinutes(10)
            }
            if ($now -ge $nextTrim) {
                Trim-ObserverMemory
                $script:LastTrim = Get-IsoNow
                $nextTrim = (Get-Date).AddSeconds([Math]::Max(10, $TrimSec))
            }
        } catch {
            $script:Erros = [int]$script:Erros + 1
            Write-PlainLog $LogDir 'observador' ('erro no ciclo: ' + $_.Exception.Message)
        }
        Start-Sleep -Milliseconds 20
    }
} finally {
    try { Write-Heartbeat } catch { }
    Close-JsonlWriters
    Write-PlainLog $LogDir 'observador' ('encerrado pid=' + $PID + ' ciclos=' + $script:Ciclos + ' erros=' + $script:Erros)
    try { $mutex.ReleaseMutex() } catch { }
    try { $mutex.Dispose() } catch { }
}
