# test-captura-curta.ps1 - prova que o observador captura processos CURTOS.
#
# TESTE SINTETICO: NAO toca no DSH. Sobe um alvo descartavel
# (powershell -c "Start-Sleep 300") e o observador apontado para ele via
# -TargetPid, com DataDir proprio dentro de <repo>\.out. Depois dispara 50
# processos curtos (cmd.exe /c exit) e mede a taxa de captura em
# processos-*.jsonl (casamento por PID no evento "start").
#
# Classes medidas:
#   1) curtos   : cmd.exe /c exit                            ACEITE >= 95% de 50
#                 (vida real medida ~30-50 ms)
#   2) ~120 ms  : cmd.exe /c "for /l %i in (1,1,60000) do @rem"
#                 calibracao: referencia do taskkill real ~117-165 ms.
#                 A taxa e a vida mediana sao EVIDENCIA, nao criterio de aceite.
#
# Nada e encerrado alem dos PIDs criados por este teste (alvo e observador).
#
# MEDICAO DE VIDA - duas grandezas diferentes, impressas com rotulo:
#   wall_ms     : medida pelo PROPRIO teste (spawn -> WaitForExit). Vida real do
#                 processo, com o overhead do Start-Process.
#   lifetime_ms : campo do JSONL de exit do observador = criacao -> deteccao da
#                 saida. Inclui ate ~1 tick de poll (25 ms) + fila de
#                 enriquecimento; na pratica fica ~+0..50 ms acima da vida real.
#                 Os 117-165 ms do taskkill real viram ~150-215 ms no JSONL.
#
# Uso (PowerShell 5.1, sem admin):
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\skills\dsh-maintenance\tests\test-captura-curta.ps1
#   powershell ... -ProcessPollMs 100      (compara com o poll antigo)
#   powershell ... -Count 100 -SettleMs 6000
#
# Exit: 0 = PASS, 1 = FAIL.

[CmdletBinding()]
param(
    [string]$RepoRoot = '',
    [int]$ProcessPollMs = 25,   # 0 = usa o default do observador
    [int]$Count = 50,
    [int]$SpawnGapMs = 50,
    [int]$SettleMs = 4000,
    [int]$CalibLoop = 60000,
    [int]$TimeoutSec = 60,
    [switch]$NoCalibration
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot '_lib-test.ps1')
if (-not $RepoRoot) { $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path }

$skillRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$observer = Join-Path $skillRoot 'scripts\observador.ps1'
$capturaScript = Join-Path $skillRoot 'scripts\captura.ps1'

$falhas = New-Object System.Collections.ArrayList
$obsPid = 0
$targetPid = 0
$dataDir = New-TestDataDir $RepoRoot 'captura-curta'
$obsDir = Join-Path $dataDir 'observacao'
$obsOut = Join-Path $dataDir 'observador.out.txt'
$obsErr = Join-Path $dataDir 'observador.err.txt'

# ---------------------------------------------------------------------------
# Helpers (leitura tolerante a arquivo aberto pelo observador)
# ---------------------------------------------------------------------------

function Read-JsonlShared([string]$Path) {
    $out = New-Object System.Collections.ArrayList
    if (-not (Test-Path -LiteralPath $Path)) { return $out.ToArray() }
    $fs = $null
    $sr = $null
    try {
        # O observador mantem o arquivo aberto com FileShare.Read; abrir aqui
        # com FileShare.ReadWrite evita "arquivo em uso".
        $fs = New-Object System.IO.FileStream($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        $sr = New-Object System.IO.StreamReader($fs)
        while ($true) {
            $ln = $sr.ReadLine()
            if ($null -eq $ln) { break }
            $null = $out.Add($ln)
        }
    } catch {
        Write-TestStamp ('   aviso: falha ao ler ' + $Path + ': ' + $_.Exception.Message)
    } finally {
        if ($null -ne $sr) { try { $sr.Dispose() } catch { } }
        if ($null -ne $fs) { try { $fs.Dispose() } catch { } }
    }
    return $out.ToArray()
}

function Get-FileBytesShared([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return [long]0 }
    $fs = $null
    try {
        $fs = New-Object System.IO.FileStream($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        return [long]$fs.Length
    } catch {
        return [long]0
    } finally {
        if ($null -ne $fs) { try { $fs.Dispose() } catch { } }
    }
}

function Get-ProcessosFiles([string]$Dir) {
    return @(Get-ChildItem -LiteralPath $Dir -Filter 'processos-*.jsonl' -File -ErrorAction SilentlyContinue |
        Sort-Object Name | ForEach-Object { $_.FullName })
}

function Get-Median($Values) {
    $v = @($Values | Where-Object { $null -ne $_ } | ForEach-Object { [double]$_ } | Sort-Object)
    if ($v.Count -eq 0) { return $null }
    $mid = [int][math]::Floor($v.Count / 2)
    if (($v.Count % 2) -eq 1) { return [math]::Round($v[$mid], 0) }
    return [math]::Round(($v[$mid - 1] + $v[$mid]) / 2, 0)
}

function Test-StartMatches([string]$Line, [datetime]$At, [int]$ToleranceSec = 5) {
    $m = [regex]::Match($Line, '"start":"([^"]+)"')
    if (-not $m.Success) { return $false }
    try {
        $t = [datetime]::Parse($m.Groups[1].Value)
        return ([math]::Abs(($t - $At).TotalSeconds) -le $ToleranceSec)
    } catch { return $false }
}

function Invoke-CmdBurst {
    param(
        [int]$HowMany,
        [int]$GapMs = 0,
        [string[]]$CmdArgs = @('/c', 'exit'),
        [switch]$WaitExit
    )
    $list = New-Object System.Collections.ArrayList
    for ($i = 0; $i -lt $HowMany; $i++) {
        $t0 = Get-Date
        $pr = $null
        try {
            $pr = Start-Process -FilePath 'cmd.exe' -ArgumentList $CmdArgs -PassThru -WindowStyle Hidden
        } catch {
            Write-TestStamp ('   aviso: falha ao disparar #' + $i + ': ' + $_.Exception.Message)
            continue
        }
        $wall = $null
        if ($WaitExit) {
            try { $pr.WaitForExit() } catch { }
            $wall = [math]::Round(((Get-Date) - $t0).TotalMilliseconds, 0)
        }
        $null = $list.Add([pscustomobject]@{ pid = [int]$pr.Id; at = $t0; wall_ms = $wall })
        if ($GapMs -gt 0 -and $i -lt ($HowMany - 1)) { Start-Sleep -Milliseconds $GapMs }
    }
    return $list.ToArray()
}

function Measure-ClassCapture {
    param(
        [string]$Dir,
        $Spawned,
        [string]$CmdNeedle = ''
    )
    $starts = @{}
    $exits = @{}
    foreach ($f in (Get-ProcessosFiles $Dir)) {
        foreach ($ln in (Read-JsonlShared $f)) {
            if ($ln.IndexOf('"event":"start"') -ge 0) {
                $m = [regex]::Match($ln, '"pid":(\d+)')
                if ($m.Success) {
                    $p = [int]$m.Groups[1].Value
                    if (-not $starts.ContainsKey($p)) { $starts[$p] = $ln }
                }
            } elseif ($ln.IndexOf('"event":"exit"') -ge 0) {
                $m = [regex]::Match($ln, '"pid":(\d+)')
                if ($m.Success) {
                    $p = [int]$m.Groups[1].Value
                    if (-not $exits.ContainsKey($p)) { $exits[$p] = $ln }
                }
            }
        }
    }
    $total = @($Spawned).Count
    $hit = 0
    $hitIdentity = 0
    $hitCmd = 0
    $hitExit = 0
    $lifetimes = New-Object System.Collections.ArrayList
    foreach ($s in @($Spawned)) {
        $p = [int]$s.pid
        if (-not $starts.ContainsKey($p)) { continue }
        $hit++
        $ln = $starts[$p]
        if (Test-StartMatches $ln $s.at 5) { $hitIdentity++ }
        if ($CmdNeedle -and ($ln -match [regex]::Escape($CmdNeedle))) { $hitCmd++ }
        if ($exits.ContainsKey($p)) {
            $hitExit++
            $ml = [regex]::Match($exits[$p], '"lifetime_ms":(\d+)')
            if ($ml.Success) { $null = $lifetimes.Add([double]$ml.Groups[1].Value) }
        }
    }
    $pct = 0.0
    if ($total -gt 0) { $pct = [math]::Round(100.0 * $hit / $total, 1) }
    $wall = @($Spawned | Where-Object { $null -ne $_.wall_ms } | ForEach-Object { $_.wall_ms })
    return [pscustomobject]@{
        total        = $total
        hit          = $hit
        pct          = $pct
        hit_identity = $hitIdentity
        hit_cmd      = $hitCmd
        hit_exit     = $hitExit
        median_life  = (Get-Median $lifetimes)
        median_wall  = (Get-Median $wall)
    }
}

function Show-EngineState {
    param([string]$Dir, [string]$Skill, [int]$PollMs)
    # (a) se o observador expuser metricas no estado.json, usa-las (mais fiel).
    $estadoPath = Join-Path $Dir 'observacao\estado.json'
    if (Test-Path -LiteralPath $estadoPath) {
        try {
            $e = (Get-Content -LiteralPath $estadoPath -Raw) | ConvertFrom-Json
            $campos = @()
            foreach ($k in @('poll_ms', 'media_tick_ms', 'maior_gap_ms', 'ticks', 'visiveis', 'descartados', 'fila')) {
                $prop = $e.PSObject.Properties[$k]
                if ($null -ne $prop -and $null -ne $prop.Value) { $campos += ($k + '=' + $prop.Value) }
            }
            $cap = $e.PSObject.Properties['captura']
            if ($null -ne $cap -and $null -ne $cap.Value) {
                foreach ($k in @('media_tick_ms', 'maior_gap_ms', 'ticks', 'visiveis', 'descartados', 'fila')) {
                    $prop = $cap.Value.PSObject.Properties[$k]
                    if ($null -ne $prop -and $null -ne $prop.Value) { $campos += ('captura.' + $k + '=' + $prop.Value) }
                }
            }
            if ($campos.Count -gt 0) {
                Write-TestStamp ('   poll efetivo (estado.json): ' + ($campos -join ' '))
                return
            }
        } catch { }
    }
    # (b) mede o engine no proprio processo do teste (sem tocar no observador).
    $capPath = Join-Path $Skill 'scripts\captura.ps1'
    if (-not (Test-Path -LiteralPath $capPath)) {
        Write-TestStamp '   poll efetivo: captura.ps1 ausente -> observador ainda no caminho antigo (poll no mesmo thread)'
        return
    }
    $iv = 25
    if ($PollMs -gt 0) { $iv = $PollMs }
    try {
        . $capPath
        if (-not (Get-Command Start-CapturaEngine -ErrorAction SilentlyContinue)) {
            Write-TestStamp '   poll efetivo: Start-CapturaEngine nao existe em captura.ps1'
            return
        }
        $ok = $false
        try { $ok = [bool](Start-CapturaEngine -IntervalMs $iv -ParentPidToIgnore $PID) } catch { $ok = $false }
        if (-not $ok) {
            Write-TestStamp '   poll efetivo: Start-CapturaEngine devolveu $false (Add-Type falhou: observador cai no caminho antigo)'
            return
        }
        Start-Sleep -Milliseconds 2000
        $st = Get-CapturaState
        Write-TestStamp ('   poll efetivo (engine no processo do teste): interval_ms=' + $st.interval_ms + ' ticks=' + $st.ticks + ' media_tick_ms=' + $st.media_tick_ms + ' maior_gap_ms=' + $st.maior_gap_ms + ' visiveis=' + $st.visiveis + ' enfileirados=' + $st.enfileirados + ' uso_cpu_ms=' + $st.uso_cpu_ms)
    } catch {
        Write-TestStamp ('   poll efetivo indisponivel: ' + $_.Exception.Message)
    } finally {
        try { Stop-CapturaEngine } catch { }
    }
}

# ---------------------------------------------------------------------------
# Execucao
# ---------------------------------------------------------------------------

$curto = $null
$calib = $null
$vidaCurta = $null
$curtoArgs = @('/c', 'exit')
$calibArgs = @('/c', ('for /l %i in (1,1,' + $CalibLoop + ') do @rem'))

try {
    if (-not (Test-Path -LiteralPath $observer)) { $null = $falhas.Add('observador ausente: ' + $observer) }
    if ($falhas.Count -gt 0) { throw 'pre-condicao falhou' }

    Write-TestStamp ('1. alvo descartavel (powershell -c Start-Sleep 300) em dataDir=' + $dataDir)
    $victim = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep 300') -PassThru -WindowStyle Hidden
    $targetPid = [int]$victim.Id
    Write-TestStamp ('   alvo pid=' + $targetPid)

    $argLine = '-NoProfile -ExecutionPolicy Bypass -File "' + $observer + '" -DataDir "' + $dataDir + '" -TargetPid ' + $targetPid + ' -DurationSeconds 240 -Port 0 -HttpProbe none -NoEvents -NoSessions'
    if ($ProcessPollMs -gt 0) { $argLine = $argLine + ' -ProcessPollMs ' + $ProcessPollMs }
    $obs = Start-Process -FilePath 'powershell.exe' -ArgumentList $argLine -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $obsOut -RedirectStandardError $obsErr
    $obsPid = [int]$obs.Id
    Write-TestStamp ('2. observador pid=' + $obsPid + ' (DataDir proprio; nao toca no DSH)')

    $estadoPath = Join-Path $obsDir 'estado.json'
    if (-not (Wait-Heartbeat $estadoPath $TimeoutSec)) {
        $null = $falhas.Add('observador nao gravou heartbeat em ' + $TimeoutSec + 's')
        Write-TestStamp '   observador nao respondeu; stderr:'
        foreach ($ln in @(Read-JsonlShared $obsErr | Select-Object -First 6)) { Write-TestStamp ('     ' + $ln) }
        throw 'sem heartbeat'
    }
    Write-TestStamp '   heartbeat fresco'

    # Vida real da classe "curto" (amostra pequena, antes da rajada).
    Write-TestStamp '3. vida real da classe curta (5 amostras com wait-for-exit)'
    $amostra = @(Invoke-CmdBurst -HowMany 5 -CmdArgs $curtoArgs -WaitExit)
    $vidaCurta = Get-Median @($amostra | ForEach-Object { $_.wall_ms })
    Write-TestStamp ('   vida mediana (wall spawn->exit) = ' + $vidaCurta + ' ms')

    Start-Sleep -Milliseconds 800

    Write-TestStamp ('4. rajada de ' + $Count + ' processos curtos (cmd.exe /c exit), gap=' + $SpawnGapMs + ' ms')
    $t0 = Get-Date
    $curtos = @(Invoke-CmdBurst -HowMany $Count -GapMs $SpawnGapMs -CmdArgs $curtoArgs)
    Write-TestStamp ('   disparados=' + $curtos.Count + ' em ' + [math]::Round(((Get-Date) - $t0).TotalSeconds, 2) + ' s; aguardando ' + $SettleMs + ' ms')
    Start-Sleep -Milliseconds $SettleMs

    $curto = Measure-ClassCapture -Dir $obsDir -Spawned $curtos -CmdNeedle 'exit'
    Write-TestStamp ('   captura curtos = ' + $curto.hit + '/' + $curto.total + ' (' + $curto.pct + '%)')
    Write-TestStamp ('   com start confirmado por horario = ' + $curto.hit_identity + '; com exit registrado = ' + $curto.hit_exit + '; cmdline com "exit" = ' + $curto.hit_cmd)
    Write-TestStamp ('   vida mediana start->exit no JSONL = ' + $curto.median_life + ' ms')

    if (-not $NoCalibration) {
        Write-TestStamp ('5. calibracao: ' + $Count + ' processos de ~120 ms (cmd.exe /c "for /l %i in (1,1,' + $CalibLoop + ') do @rem"), um por vez')
        $calibSpawn = @(Invoke-CmdBurst -HowMany $Count -CmdArgs $calibArgs -WaitExit)
        Write-TestStamp ('   disparados=' + $calibSpawn.Count + '; aguardando ' + $SettleMs + ' ms')
        Start-Sleep -Milliseconds $SettleMs
        $calib = Measure-ClassCapture -Dir $obsDir -Spawned $calibSpawn -CmdNeedle 'for /l'
        Write-TestStamp ('   captura ~120 ms = ' + $calib.hit + '/' + $calib.total + ' (' + $calib.pct + '%)')
        Write-TestStamp ('   vida mediana start->exit no JSONL = ' + $calib.median_life + ' ms; wall median = ' + $calib.median_wall + ' ms')
    }

    Write-TestStamp '6. intervalo efetivo de poll (estado.json / Get-CapturaState)'
    Show-EngineState -Dir $dataDir -Skill $skillRoot -PollMs $ProcessPollMs
} catch {
    $msg = [string]$_.Exception.Message
    if ($msg -ne 'sem heartbeat' -and $msg -ne 'pre-condicao falhou') { $null = $falhas.Add('erro: ' + $msg) }
} finally {
    if ($obsPid -gt 0) { try { Stop-Process -Id $obsPid -Force -ErrorAction SilentlyContinue } catch { } }
    if ($targetPid -gt 0) { try { Stop-Process -Id $targetPid -Force -ErrorAction SilentlyContinue } catch { } }
}

# ---------------------------------------------------------------------------
# Veredito
# ---------------------------------------------------------------------------

Write-Host ''
Write-Host '== METRICAS: captura de processos curtos =='
Write-Host ('dataDir            : ' + $dataDir)
if ($ProcessPollMs -gt 0) { Write-Host ('-ProcessPollMs     : ' + $ProcessPollMs) } else { Write-Host '-ProcessPollMs     : (default do observador)' }
$minimo = [int][math]::Ceiling(0.95 * $Count)
if ($null -ne $curto) {
    Write-Host ('curtos (cmd /c exit): ' + $curto.hit + '/' + $curto.total + ' (' + $curto.pct + '%)  aceite >= 95% (' + $minimo + '/' + $Count + ')')
    Write-Host ('  start confirmado por horario : ' + $curto.hit_identity + '/' + $curto.total)
    Write-Host ('  com exit tambem registrado   : ' + $curto.hit_exit + '/' + $curto.total)
    Write-Host ('  cmdline com "exit"           : ' + $curto.hit_cmd + '/' + $curto.total)
    Write-Host ('  vida mediana JSONL (criacao->deteccao): ' + $curto.median_life + ' ms')
    Write-Host ('  vida mediana wall (spawn->WaitForExit): ' + $vidaCurta + ' ms (5 amostras antes da rajada)')
    if ($curto.hit -lt $minimo) { $null = $falhas.Add('taxa de captura de curtos ' + $curto.pct + '% < 95%') }
} else {
    Write-Host 'curtos (cmd /c exit): NAO MEDIDO'
    if ($falhas.Count -eq 0) { $null = $falhas.Add('medicao dos curtos nao executou') }
}
if ($null -ne $calib) {
    Write-Host ('~120 ms (for /l ...) : ' + $calib.hit + '/' + $calib.total + ' (' + $calib.pct + '%)  [evidencia de calibracao]')
    Write-Host ('  vida mediana JSONL (criacao->deteccao): ' + $calib.median_life + ' ms  [inclui ~1 tick de poll; taskkill real 117-165 ms -> ~150-215 ms aqui]')
    Write-Host ('  vida mediana wall (spawn->WaitForExit): ' + $calib.median_wall + ' ms  [comparar com taskkill real 117-165 ms]')
    if ($null -ne $calib.median_life) {
        if ([double]$calib.median_life -lt 40 -or [double]$calib.median_life -gt 500) {
            Write-Host ('  AVISO: vida mediana fora da faixa esperada (~120 ms): calibracao nao representa o taskkill')
        }
    }
}
Write-Host ''
if ($falhas.Count -eq 0) {
    Write-Host ('RESULTADO: PASS - captura de processos curtos ' + $curto.hit + '/' + $curto.total + ' (' + $curto.pct + '%) >= 95%.')
    exit 0
} else {
    Write-Host ('RESULTADO: FAIL - ' + ($falhas -join '; '))
    exit 1
}
