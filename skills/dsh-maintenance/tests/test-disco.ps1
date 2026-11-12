# test-disco.ps1 - mede o disco do observador sob churn e prova o teto diario.
#
# TESTE SINTETICO: NAO toca no DSH. Duas rodadas independentes, cada uma com
# DataDir proprio dentro de <repo>\.out, alvo descartavel (-TargetPid) e
# -Port 0, para o observador nunca adotar o DSH da porta 3080.
#
# Rodada A (prova do teto): observador com -MaxDayMb 0.2 (fracao do CONTRATO-33)
#   + churn de processos curtos ate o teto estourar. Prova:
#     - o processos-*.jsonl cresce, para de crescer e NAO passa do teto;
#     - resumo-YYYY-MM-DD.jsonl existe com o resumo do dia (teto/usado/motivo).
#   Se o observador truncar a fracao (parametro [int] em vez de [double]), a
#   prova com 0.2 e considerada INVALIDA e o teste roda um fallback com
#   -MaxDayMb 1 (inteiro) apenas para provar o mecanismo de corte + resumo.
#
# Rodada B (medicao com o default 150): churn de 2 min; mede bytes/min, extrapola
#   MB/dia, imprime o custo por processo e a taxa de churn que chegaria a
#   200 MB/dia e a 150 MB/dia. A extrapolacao e LINEAR a partir de 2 min de
#   churn sintetico (limitacao declarada no output).
#
# Criterio de PASS:
#   Rodada A: teto efetivo == pedido, processos congelado depois do estouro,
#             bytes <= teto e resumo-*.jsonl gravado.
#   Rodada B: nunca passar de 150 MB escritos no dia E (extrapolacao < 200 MB/dia
#             OU o teto de 150 MB/dia efetivamente aplicado/provado na Rodada A).
#
# Uso (PowerShell 5.1, sem admin):
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\skills\dsh-maintenance\tests\test-disco.ps1
#   ... -Minutes 1 -ChurnIntervalMs 500   (medicao mais curta)
#   ... -SkipCeiling                      (so a medicao de 2 min)
#   ... -SkipMeasurement                  (so a prova do teto)
#   ... -Quick                            (rodada A curta + 30 s de medicao)
#
# Exit: 0 = PASS, 1 = FAIL.

[CmdletBinding()]
param(
    [string]$RepoRoot = '',
    [double]$CeilingMb = 0.2,
    [int]$CeilingIntervalMs = 120,
    [int]$CeilingBatch = 3,
    [int]$CeilingTimeoutSec = 90,
    [double]$Minutes = 2,
    [int]$ChurnIntervalMs = 250,
    [int]$ProcessPollMs = 0,      # 0 = default do observador (25)
    [switch]$SkipCeiling,
    [switch]$SkipMeasurement,
    [switch]$Quick
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot '_lib-test.ps1')
if (-not $RepoRoot) { $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path }

$skillRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$observer = Join-Path $skillRoot 'scripts\observador.ps1'
if ($Quick) {
    if ($Minutes -gt 0.5) { $Minutes = 0.5 }
    if ($CeilingTimeoutSec -gt 45) { $CeilingTimeoutSec = 45 }
}
$churnArgs = @('/c', 'exit')

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

$Inv = [System.Globalization.CultureInfo]::InvariantCulture
$InvDec = [System.Globalization.NumberStyles]::Float

# Formata numero com ponto decimal (o relatorio fica estavel em qualquer locale).
function Num($Value, [int]$Dec = 2) {
    if ($null -eq $Value) { return 'n/d' }
    try { return ([double]$Value).ToString('F' + $Dec, $Inv) } catch { return [string]$Value }
}

function To-DoubleInvariant([string]$Text) {
    $d = [double]0
    if ([double]::TryParse($Text, $InvDec, $Inv, [ref]$d)) { return $d }
    return [double]0
}

function Read-JsonlShared([string]$Path) {
    $out = New-Object System.Collections.ArrayList
    if (-not (Test-Path -LiteralPath $Path)) { return $out.ToArray() }
    $fs = $null
    $sr = $null
    try {
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

function Get-ObsFileMap([string]$ObsDir) {
    $map = @{}
    foreach ($f in @(Get-ChildItem -LiteralPath $ObsDir -File -Filter '*.jsonl' -ErrorAction SilentlyContinue)) {
        $map[[string]$f.Name] = Get-FileBytesShared $f.FullName
    }
    return $map
}

function Get-MapTotal($Map) {
    $t = [long]0
    foreach ($k in @($Map.Keys)) { $t = $t + [long]$Map[$k] }
    return $t
}

function Get-MapCategory($Map, [string]$Prefix) {
    $t = [long]0
    foreach ($k in @($Map.Keys)) {
        if ([string]$k -like ($Prefix + '-*')) { $t = $t + [long]$Map[$k] }
    }
    return $t
}

function Get-Estado([string]$DataDir) {
    $p = Join-Path $DataDir 'observacao\estado.json'
    if (-not (Test-Path -LiteralPath $p)) { return $null }
    try { return ((Get-Content -LiteralPath $p -Raw) | ConvertFrom-Json) } catch { return $null }
}

function Get-ResumoPath([string]$ObsDir) {
    $f = @(Get-ChildItem -LiteralPath $ObsDir -File -Filter 'resumo-*.jsonl' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1)
    if ($f.Count -lt 1) { return $null }
    return $f[0].FullName
}

function Start-TestObserver {
    param(
        [string]$DataDir,
        [int]$TargetPid,
        [string]$MaxDayMbArg,
        [int]$DurationSeconds,
        [bool]$Lean,
        [int]$PollMs
    )
    $argLine = '-NoProfile -ExecutionPolicy Bypass -File "' + $observer + '" -DataDir "' + $DataDir + '" -TargetPid ' + $TargetPid +
        ' -DurationSeconds ' + $DurationSeconds + ' -Port 0 -HttpProbe none'
    if ($MaxDayMbArg) { $argLine = $argLine + ' -MaxDayMb ' + $MaxDayMbArg }
    if ($Lean) { $argLine = $argLine + ' -NoEvents -NoSessions' }
    if ($PollMs -gt 0) { $argLine = $argLine + ' -ProcessPollMs ' + $PollMs }
    $outFile = Join-Path $DataDir 'observador.out.txt'
    $errFile = Join-Path $DataDir 'observador.err.txt'
    return (Start-Process -FilePath 'powershell.exe' -ArgumentList $argLine -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput $outFile -RedirectStandardError $errFile)
}

function Show-ObserverError([string]$DataDir) {
    $errFile = Join-Path $DataDir 'observador.err.txt'
    foreach ($ln in @(Read-JsonlShared $errFile | Select-Object -First 6)) { Write-TestStamp ('     ' + $ln) }
}

function Invoke-ChurnBatch {
    param([int]$HowMany, [string[]]$CmdArgs = $churnArgs)
    $n = 0
    for ($i = 0; $i -lt $HowMany; $i++) {
        try {
            $null = Start-Process -FilePath 'cmd.exe' -ArgumentList $CmdArgs -PassThru -WindowStyle Hidden
            $n++
        } catch { }
    }
    return $n
}

# ---------------------------------------------------------------------------
# Rodada A: prova do teto diario (corte + resumo)
# ---------------------------------------------------------------------------

function New-CeilResult {
    param($Nome, $DataDir, $Problemas, $MaxEfetivo, $TetoBytes, $BytesAntes, $BytesDepois, $Congelado, $Resumo, $ResumoObj, $Churn, $Samples)
    return [pscustomobject]@{
        nome         = $Nome
        dataDir      = $DataDir
        problemas    = @($Problemas)
        max_efetivo  = $MaxEfetivo
        teto_bytes   = $TetoBytes
        bytes_antes  = $BytesAntes
        bytes_depois = $BytesDepois
        congelado    = $Congelado
        resumo       = $Resumo
        resumo_obj   = $ResumoObj
        churn        = $Churn
        samples      = @($Samples)
        fallback     = $null
    }
}

function Invoke-CeilingRound {
    param(
        [string]$Nome,
        [string]$MaxDayMbArg,
        [string]$DataName
    )
    $problemas = New-Object System.Collections.ArrayList
    $dataDir = New-TestDataDir $RepoRoot $DataName
    $obsDir = Join-Path $dataDir 'observacao'
    $obsPid = 0
    $targetPid = 0
    $bytesAntes = [long]0
    $bytesDepois = [long]0
    $tetoBytes = [long]0
    $maxEfetivo = $null
    $congelado = $false
    $resumoPath = $null
    $resumoObj = $null
    $passos = 0
    $samples = New-Object System.Collections.ArrayList

    Write-TestStamp ('[' + $Nome + '] dataDir=' + $dataDir + ' -MaxDayMb ' + $MaxDayMbArg)
    try {
        if (-not (Test-Path -LiteralPath $observer)) {
            $null = $problemas.Add('observador ausente: ' + $observer)
            return (New-CeilResult -Nome $Nome -DataDir $dataDir -Problemas $problemas.ToArray() -MaxEfetivo $maxEfetivo -TetoBytes $tetoBytes -BytesAntes $bytesAntes -BytesDepois $bytesDepois -Congelado $congelado -Resumo $resumoPath -ResumoObj $resumoObj -Churn $passos -Samples $samples.ToArray())
        }
        $tv = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep 300') -PassThru -WindowStyle Hidden
        $targetPid = [int]$tv.Id
        $obs = Start-TestObserver -DataDir $dataDir -TargetPid $targetPid -MaxDayMbArg $MaxDayMbArg -DurationSeconds 200 -Lean $true -PollMs $ProcessPollMs
        $obsPid = [int]$obs.Id
        if (-not (Wait-Heartbeat (Join-Path $obsDir 'estado.json') 40)) {
            $null = $problemas.Add('[' + $Nome + '] observador nao gravou heartbeat (parametro novo nao suportado?)')
            Write-TestStamp ('[' + $Nome + '] stderr do observador:')
            Show-ObserverError $dataDir
            return (New-CeilResult -Nome $Nome -DataDir $dataDir -Problemas $problemas.ToArray() -MaxEfetivo $maxEfetivo -TetoBytes $tetoBytes -BytesAntes $bytesAntes -BytesDepois $bytesDepois -Congelado $congelado -Resumo $resumoPath -ResumoObj $resumoObj -Churn $passos -Samples $samples.ToArray())
        }
        Start-Sleep -Milliseconds 1500
        # O heartbeat e escrito a cada 5 s; o bloco "disco" pode nao estar no
        # primeiro deles. Espera ate 10 s pelo estado com o teto exposto.
        $est = $null
        for ($tent = 0; $tent -lt 20; $tent++) {
            $est = Get-Estado $dataDir
            if ($null -ne $est -and $null -ne $est.disco -and $null -ne $est.disco.max_mb) { break }
            Start-Sleep -Milliseconds 500
        }
        $tetoPedido = To-DoubleInvariant $MaxDayMbArg
        if ($null -ne $est) {
            if ($null -ne $est.disco -and $null -ne $est.disco.max_mb) { $maxEfetivo = [double]$est.disco.max_mb }
            Write-TestStamp ('[' + $Nome + '] poll_ms=' + $est.poll_ms + ' teto pedido=' + (Num $tetoPedido 3) + ' MB; teto efetivo no estado.json (disco.max_mb)=' + $(if ($null -ne $maxEfetivo) { Num $maxEfetivo 3 } else { 'nao exposto' }))
        } else {
            Write-TestStamp ('[' + $Nome + '] estado.json ilegivel; assumindo teto pedido ' + $MaxDayMbArg)
        }
        if ($null -ne $maxEfetivo -and $maxEfetivo -le 0 -and $tetoPedido -gt 0) {
            $null = $problemas.Add('[' + $Nome + '] teto efetivo 0: -MaxDayMb ' + $MaxDayMbArg + ' foi truncado (observador declara o param como [int] em vez de [double]) -> prova com fracao invalida')
        }
        if ($null -eq $maxEfetivo) { $maxEfetivo = $tetoPedido }
        if ($maxEfetivo -gt 0) { $tetoBytes = [long][math]::Round($maxEfetivo * 1048576) }

        $deadline = (Get-Date).AddSeconds($CeilingTimeoutSec)
        $prevBytes = [long]-1
        $frozen = 0
        $primeiro = $null
        while ((Get-Date) -lt $deadline) {
            $passos = $passos + (Invoke-ChurnBatch -HowMany $CeilingBatch)
            Start-Sleep -Milliseconds $CeilingIntervalMs
            $bytes = Get-MapCategory (Get-ObsFileMap $obsDir) 'processos'
            if ($null -eq $primeiro -and $bytes -gt 0) { $primeiro = $bytes }
            $rp = Get-ResumoPath $obsDir
            if ($rp) { $resumoPath = $rp }
            if ($rp -and $bytes -gt 0 -and $bytes -eq $prevBytes) { $frozen++ } else { $frozen = 0 }
            $null = $samples.Add([pscustomobject]@{ t = (Get-Date); bytes = [long]$bytes })
            $prevBytes = $bytes
            if ($frozen -ge 2) { $congelado = $true; break }
        }
        $bytesDepois = Get-MapCategory (Get-ObsFileMap $obsDir) 'processos'
        if ($null -ne $primeiro) { $bytesAntes = [long]$primeiro }

        # Prova extra do congelamento: mais 2 amostras com churn continuando.
        if ($congelado) {
            $c1 = $bytesDepois
            $null = Invoke-ChurnBatch -HowMany (2 * $CeilingBatch)
            Start-Sleep -Milliseconds 1500
            $c2 = Get-MapCategory (Get-ObsFileMap $obsDir) 'processos'
            Write-TestStamp ('[' + $Nome + '] congelamento confirmado com churn ativo: ' + $c1 + ' -> ' + $c2 + ' bytes')
            if ($c2 -ne $c1) {
                $congelado = $false
                $null = $problemas.Add('[' + $Nome + '] processos-*.jsonl voltou a crescer depois do teto (' + $c1 + ' -> ' + $c2 + ')')
            }
            $bytesDepois = $c2
        } else {
            $null = $problemas.Add('[' + $Nome + '] processos-*.jsonl nao congelou em ' + $CeilingTimeoutSec + ' s de churn (bytes=' + $bytesDepois + ', resumo=' + [string]$resumoPath + ')')
        }

        if (-not $resumoPath) {
            $null = $problemas.Add('[' + $Nome + '] resumo-*.jsonl nao foi gravado depois do estouro do teto')
        } else {
            $linhas = @(Read-JsonlShared $resumoPath)
            Write-TestStamp ('[' + $Nome + '] resumo=' + (Split-Path $resumoPath -Leaf) + ' linhas=' + $linhas.Count)
            if ($linhas.Count -gt 0) {
                Write-TestStamp ('[' + $Nome + '] resumo[1]: ' + $linhas[0])
                try { $resumoObj = ($linhas[0] | ConvertFrom-Json) } catch { $resumoObj = $null }
            }
            if ($linhas.Count -lt 1) { $null = $problemas.Add('[' + $Nome + '] resumo-*.jsonl vazio') }
            # O resumo e a fonte autoritativa do teto efetivo.
            if ($null -ne $resumoObj) {
                try { if ($null -ne $resumoObj.teto_bytes -and [long]$resumoObj.teto_bytes -gt 0) { $tetoBytes = [long]$resumoObj.teto_bytes } } catch { }
                try { if ($null -ne $resumoObj.max_mb) { $maxEfetivo = [double]$resumoObj.max_mb } } catch { }
            }
        }
        if ($tetoPedido -gt 0 -and $null -ne $maxEfetivo -and [math]::Abs([double]$maxEfetivo - $tetoPedido) -gt 0.0005) {
            $null = $problemas.Add('[' + $Nome + '] teto efetivo (' + (Num $maxEfetivo 3) + ' MB) diferente do pedido (' + (Num $tetoPedido 3) + ' MB)')
        }

        if ($tetoBytes -gt 0 -and $bytesDepois -gt ($tetoBytes + 8192)) {
            $null = $problemas.Add('[' + $Nome + '] bytes do processos passaram do teto: ' + $bytesDepois + ' > ' + $tetoBytes)
        }
        if ($congelado -and $bytesDepois -le 0) {
            $null = $problemas.Add('[' + $Nome + '] processos-*.jsonl vazio: o corte nao pode ser provado (teto 0?)')
        }
        Write-TestStamp ('[' + $Nome + '] churn=' + $passos + ' proc; processos antes=' + $bytesAntes + ' B, depois=' + $bytesDepois + ' B; teto=' + $tetoBytes + ' B')
    } catch {
        $null = $problemas.Add('[' + $Nome + '] erro: ' + [string]$_.Exception.Message)
    } finally {
        if ($obsPid -gt 0) { try { Stop-Process -Id $obsPid -Force -ErrorAction SilentlyContinue } catch { } }
        if ($targetPid -gt 0) { try { Stop-Process -Id $targetPid -Force -ErrorAction SilentlyContinue } catch { } }
    }
    return (New-CeilResult -Nome $Nome -DataDir $dataDir -Problemas $problemas.ToArray() -MaxEfetivo $maxEfetivo -TetoBytes $tetoBytes -BytesAntes $bytesAntes -BytesDepois $bytesDepois -Congelado $congelado -Resumo $resumoPath -ResumoObj $resumoObj -Churn $passos -Samples $samples.ToArray())
}

# ---------------------------------------------------------------------------
# Rodada B: medicao de 2 min com o default 150 MB/dia
# ---------------------------------------------------------------------------

function Invoke-MeasurementRound {
    param([double]$Minutos, [int]$IntervaloMs)
    $problemas = New-Object System.Collections.ArrayList
    $dataDir = New-TestDataDir $RepoRoot 'disco-medicao'
    $obsDir = Join-Path $dataDir 'observacao'
    $obsPid = 0
    $targetPid = 0
    $r = [pscustomobject]@{
        dataDir = $dataDir; problemas = $problemas.ToArray(); mb_min = 0.0; mb_dia = 0.0
        bytes0 = [long]0; bytes1 = [long]0; churn = 0; seg = 0.0; usado_mb = $null
        max_mb = $null; excedido = $null; resumo = $null; categorias = @{}; por_proc = $null
        break200 = $null; break150 = $null; taxa = 0.0; poll_ms = $null
        amostra_n = 0; amostra_rec = $null; amostra_anc = $null
    }

    Write-TestStamp ('[B] dataDir=' + $dataDir + ' -MaxDayMb 150; churn ' + (Num $Minutos 2) + ' min a 1 processo cada ' + $IntervaloMs + ' ms')
    try {
        if (-not (Test-Path -LiteralPath $observer)) { $null = $problemas.Add('observador ausente: ' + $observer); return $r }
        $tv = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep 300') -PassThru -WindowStyle Hidden
        $targetPid = [int]$tv.Id
        $obs = Start-TestObserver -DataDir $dataDir -TargetPid $targetPid -MaxDayMbArg '150' -DurationSeconds ([int]($Minutos * 60 + 180)) -Lean $false -PollMs $ProcessPollMs
        $obsPid = [int]$obs.Id
        if (-not (Wait-Heartbeat (Join-Path $obsDir 'estado.json') 40)) {
            $null = $problemas.Add('[B] observador nao gravou heartbeat')
            Write-TestStamp '[B] stderr do observador:'
            Show-ObserverError $dataDir
            return $r
        }
        # Aquece 6 s: o baseline, o primeiro snapshot (2 s) e a PRIMEIRA varredura
        # de sessoes (~3 s, que reporta tudo como "changed") saem da conta.
        Start-Sleep -Milliseconds 6000
        $mapa0 = Get-ObsFileMap $obsDir
        $bytes0 = Get-MapTotal $mapa0
        $est0 = Get-Estado $dataDir
        $t0 = Get-Date
        $fim = $t0.AddSeconds($Minutos * 60)
        $churn = 0
        while ((Get-Date) -lt $fim) {
            $churn = $churn + (Invoke-ChurnBatch -HowMany 1)
            Start-Sleep -Milliseconds $IntervaloMs
        }
        $t1 = Get-Date
        # Espera o ultimo flush/exit aparecer antes de fechar a conta.
        Start-Sleep -Milliseconds 2500
        $mapa1 = Get-ObsFileMap $obsDir
        $bytes1 = Get-MapTotal $mapa1
        $seg = ($t1 - $t0).TotalSeconds
        $minutos = $seg / 60.0
        $delta = [double]($bytes1 - $bytes0)
        $mbDia = ($delta / 1048576.0) / $minutos * 1440.0
        $mbMin = ($delta / 1048576.0) / $minutos

        # Deltas por categoria
        $cats = @{}
        foreach ($k in @($mapa1.Keys)) {
            $antes = [long]0
            if ($mapa0.ContainsKey($k)) { $antes = [long]$mapa0[$k] }
            $cats[[string]$k] = [long]([long]$mapa1[$k] - $antes)
        }
        $deltaProc = [long]0
        foreach ($k in @($cats.Keys)) { if ([string]$k -like 'processos-*') { $deltaProc = $deltaProc + [long]$cats[$k] } }
        $porProc = $null
        if ($churn -gt 0) { $porProc = [math]::Round($deltaProc / $churn, 0) }

        # Composicao do registro: a cadeia de ancestrais repete o cmdline de quem
        # subiu o teste em CADA registro, entao o custo por processo depende de como
        # o teste foi lancado. Medir e imprimir isso evita extrapolacao enganosa.
        $amostraN = 0
        $amostraTotal = [double]0
        $amostraAnc = [double]0
        foreach ($pf in @(Get-ChildItem -LiteralPath $obsDir -File -Filter 'processos-*.jsonl' -ErrorAction SilentlyContinue)) {
            if ($amostraN -ge 20) { break }
            foreach ($ln in (Read-JsonlShared $pf.FullName)) {
                if ($amostraN -ge 20) { break }
                if ($ln.IndexOf('"event":"start"') -lt 0) { continue }
                if ($ln.IndexOf('"name":"cmd.exe"') -lt 0) { continue }
                try {
                    $obj = ($ln | ConvertFrom-Json)
                    $amostraTotal = $amostraTotal + [double]$ln.Length
                    $ancTxt = ($obj.ancestors | ConvertTo-Json -Compress -Depth 6)
                    if ($null -ne $ancTxt) { $amostraAnc = $amostraAnc + [double]([string]$ancTxt).Length }
                    $amostraN++
                } catch { }
            }
        }

        $est = Get-Estado $dataDir
        $usadoMb = $null
        $maxMb = $null
        $excedido = $null
        $pollMs = $null
        if ($null -ne $est) {
            if ($null -ne $est.poll_ms) { $pollMs = $est.poll_ms }
            if ($null -ne $est.disco) {
                if ($null -ne $est.disco.usado_mb) { $usadoMb = [double]$est.disco.usado_mb }
                if ($null -ne $est.disco.max_mb) { $maxMb = [double]$est.disco.max_mb }
                if ($null -ne $est.disco.excedido) { $excedido = [bool]$est.disco.excedido }
            }
        }
        $resumo = Get-ResumoPath $obsDir
        $break200 = $null
        $break150 = $null
        if ($null -ne $porProc -and $porProc -gt 0) {
            $break200 = [math]::Round((200.0 * 1048576.0 / 1440.0) / $porProc / 60.0, 2)
            $break150 = [math]::Round((150.0 * 1048576.0 / 1440.0) / $porProc / 60.0, 2)
        }
        $r = [pscustomobject]@{
            dataDir    = $dataDir
            problemas  = $problemas.ToArray()
            mb_min     = [math]::Round($mbMin, 4)
            mb_dia     = [math]::Round($mbDia, 1)
            bytes0     = $bytes0
            bytes1     = $bytes1
            churn      = $churn
            seg        = [math]::Round($seg, 1)
            taxa       = [math]::Round(($churn / $seg), 2)
            usado_mb   = $usadoMb
            max_mb     = $maxMb
            excedido   = $excedido
            resumo     = $resumo
            categorias = $cats
            por_proc   = $porProc
            break200   = $break200
            break150   = $break150
            poll_ms    = $pollMs
            amostra_n  = $amostraN
            amostra_rec = $(if ($amostraN -gt 0) { [math]::Round($amostraTotal / $amostraN, 0) } else { $null })
            amostra_anc = $(if ($amostraN -gt 0) { [math]::Round($amostraAnc / $amostraN, 0) } else { $null })
        }
        if ($null -eq $est) { $null = $problemas.Add('[B] estado.json ilegivel no fim da medicao') }
        if ($null -ne $resumo) { $null = $problemas.Add('[B] resumo-*.jsonl apareceu com o default 150 MB: o teto foi atingido na medicao') }
        if ($null -eq $usadoMb) { $null = $problemas.Add('[B] estado.json sem bloco disco (teto nao exposto)') }
    } catch {
        $null = $problemas.Add('[B] erro: ' + [string]$_.Exception.Message)
    } finally {
        if ($obsPid -gt 0) { try { Stop-Process -Id $obsPid -Force -ErrorAction SilentlyContinue } catch { } }
        if ($targetPid -gt 0) { try { Stop-Process -Id $targetPid -Force -ErrorAction SilentlyContinue } catch { } }
    }
    return $r
}

# ---------------------------------------------------------------------------
# Execucao
# ---------------------------------------------------------------------------

$falhas = New-Object System.Collections.ArrayList
$a = $null
$b = $null
$capProven = $false

if (-not $SkipCeiling) {
    Write-Host ''
    Write-TestStamp '== RODADA A: prova do teto diario (corte + resumo) =='
    $a = Invoke-CeilingRound -Nome 'A1' -MaxDayMbArg '0.2' -DataName 'disco-teto'
    if ($null -eq $a) {
        $null = $falhas.Add('Rodada A nao devolveu resultado')
    } else {
        foreach ($p in @($a.problemas)) { $null = $falhas.Add($p) }
    }
    if ($null -ne $a -and @($a.problemas).Count -eq 0) {
        $capProven = $true
    } else {
        # Rede de seguranca: se a fracao 0.2 chegar truncada em 0 (parametro
        # declarado como [int] em vez de [double]), a prova com fracao e
        # reprovada de forma explicita e ainda assim se prova o MECANISMO de
        # corte+resumo com um teto inteiro.
        $truncado = (@($a.problemas) | Where-Object { $_ -like '*truncado*' }).Count -gt 0
        if ($truncado) {
            Write-Host ''
            Write-TestStamp '== RODADA A2 (fallback): prova do mecanismo com -MaxDayMb 1 (inteiro) =='
            $a2 = Invoke-CeilingRound -Nome 'A2' -MaxDayMbArg '1' -DataName 'disco-teto-int'
            foreach ($p in @($a2.problemas)) { $null = $falhas.Add($p) }
            if (@($a2.problemas).Count -eq 0) {
                $capProven = $true
                Write-TestStamp '   (mecanismo corte+resumo provado com 1 MB; a prova da FRACAO 0.2 continua reprovada)'
            }
            $a = [pscustomobject]@{
                nome = 'A1+A2'; dataDir = $a.dataDir; problemas = $a.problemas; max_efetivo = $a.max_efetivo
                teto_bytes = $a.teto_bytes; bytes_antes = $a.bytes_antes; bytes_depois = $a.bytes_depois
                congelado = $a.congelado; resumo = $a.resumo; resumo_obj = $a.resumo_obj; churn = $a.churn
                samples = $a.samples; fallback = $a2
            }
        }
    }
}

if (-not $SkipMeasurement) {
    Write-Host ''
    Write-TestStamp '== RODADA B: medicao de disco com o default 150 MB/dia =='
    $b = Invoke-MeasurementRound -Minutos $Minutes -IntervaloMs $ChurnIntervalMs
    if ($null -eq $b) {
        $null = $falhas.Add('Rodada B nao devolveu resultado')
    } else {
        foreach ($p in @($b.problemas)) { $null = $falhas.Add($p) }
    }
}

# ---------------------------------------------------------------------------
# Relatorio
# ---------------------------------------------------------------------------

Write-Host ''
Write-Host '== RODADA A: prova do teto diario =='
if ($null -eq $a) {
    Write-Host 'nao executada (-SkipCeiling)'
} else {
    Write-Host ('dataDir              : ' + $a.dataDir)
    Write-Host ('teto efetivo         : ' + (Num $a.max_efetivo 3) + ' MB (' + $a.teto_bytes + ' bytes)')
    Write-Host ('processos bytes antes: ' + $a.bytes_antes)
    Write-Host ('processos bytes depois: ' + $a.bytes_depois + '  (congelado=' + $a.congelado + ', churn=' + $a.churn + ' proc)')
    Write-Host ('resumo-*.jsonl       : ' + $(if ($a.resumo) { Split-Path $a.resumo -Leaf } else { 'AUSENTE' }))
    if (@($a.samples).Count -gt 0) {
        $sv = @($a.samples | ForEach-Object { [string]$_.bytes })
        $mostra = $sv
        if ($sv.Count -gt 14) { $mostra = @($sv[0..3]) + @('...') + @($sv[($sv.Count - 6)..($sv.Count - 1)]) }
        Write-Host ('amostras de bytes    : ' + ($mostra -join ',') + '  (' + $sv.Count + ' amostras)')
        Write-Host ('cresceu?             : ' + $(if ($a.bytes_depois -gt $a.bytes_antes) { 'sim: ' + $a.bytes_antes + ' -> ' + $a.bytes_depois } else { 'nao medido (teto atingido antes da 1a amostra)' }))
    }
    if ($null -ne $a.resumo_obj) {
        $ro = $a.resumo_obj
        Write-Host ('  resumo: dia=' + $ro.dia + ' max_mb=' + (Num $ro.max_mb 3) + ' usado_mb=' + (Num $ro.usado_mb 3) + ' excedido=' + $ro.excedido + ' bloqueados=' + $ro.bloqueados + ' motivo=' + $ro.motivo)
        if ([long]$a.teto_bytes -gt 0) {
            Write-Host ('  uso final do processos-*.jsonl = ' + (Num (100.0 * $a.bytes_depois / [double]$a.teto_bytes) 1) + '% do teto')
        }
    }
    if ($null -ne $a.fallback) {
        $f = $a.fallback
        Write-Host ('fallback -MaxDayMb 1: teto=' + (Num $f.max_efetivo 3) + ' MB, bytes ' + $f.bytes_antes + ' -> ' + $f.bytes_depois + ', congelado=' + $f.congelado + ', resumo=' + $(if ($f.resumo) { 'sim' } else { 'AUSENTE' }))
    }
    $probsA = @($a.problemas)
    if ($probsA.Count -eq 0) { Write-Host 'PROVA: OK - o processos-*.jsonl parou de crescer no teto e o resumo foi gravado.' }
    else { foreach ($p in $probsA) { Write-Host ('PROBLEMA: ' + $p) } }
}

Write-Host ''
Write-Host '== RODADA B: medicao (extrapolacao linear de churn sintetico) =='
if ($null -eq $b) {
    Write-Host 'nao executada (-SkipMeasurement)'
} else {
    Write-Host ('dataDir              : ' + $b.dataDir + '  poll_ms=' + $b.poll_ms)
    Write-Host ('churn                : ' + $b.churn + ' processos em ' + (Num $b.seg 1) + ' s (' + (Num $b.taxa 2) + ' proc/s)')
    Write-Host ('bytes observados     : ' + $b.bytes0 + ' -> ' + $b.bytes1 + ' B (delta ' + ($b.bytes1 - $b.bytes0) + ' B)')
    Write-Host ('bytes por processo   : ' + $b.por_proc + ' B (categoria processos)')
    if ($null -ne $b.amostra_rec) {
        $pctAnc = 0.0
        if ([double]$b.amostra_rec -gt 0) { $pctAnc = 100.0 * [double]$b.amostra_anc / [double]$b.amostra_rec }
        Write-Host ('amostra de registro  : ' + $b.amostra_rec + ' B/registro, dos quais ' + $b.amostra_anc + ' B (' + (Num $pctAnc 1) + '%) sao a cadeia de ancestrais (n=' + $b.amostra_n + ')')
    }
    Write-Host ('taxa medida          : ' + (Num $b.mb_min 4) + ' MB/min -> extrapolacao ' + (Num $b.mb_dia 1) + ' MB/dia')
    Write-Host ('uso do dia (estado)  : ' + (Num $b.usado_mb 3) + ' MB de ' + (Num $b.max_mb 1) + ' MB (excedido=' + $b.excedido + ')')
    Write-Host ('resumo-*.jsonl       : ' + $(if ($b.resumo) { 'PRESENTE (teto atingido na medicao)' } else { 'ausente (teto nao atingido em ' + (Num $b.seg 1) + ' s)' }))
    Write-Host '  por categoria (delta no periodo):'
    foreach ($k in @($b.categorias.Keys | Sort-Object)) {
        Write-Host ('    ' + ([string]$k).PadRight(34) + ' ' + ([string]$b.categorias[$k]).PadLeft(9) + ' B')
    }
    Write-Host ('taxa de churn que atinge 200 MB/dia : ' + (Num $b.break200 2) + ' proc/s')
    Write-Host ('taxa de churn que atinge 150 MB/dia : ' + (Num $b.break150 2) + ' proc/s')
    if ($null -ne $b.mb_dia -and $b.mb_dia -ge 200) {
        Write-Host ('AVISO: extrapolacao ' + (Num $b.mb_dia 1) + ' MB/dia >= 200 MB/dia. Nesse cenario, apenas o teto diario (' + (Num $b.max_mb 1) + ' MB/dia) limita o uso real do dia.')
    }
    Write-Host ('LIMITACAO: extrapolacao linear de churn sintetico de ' + (Num $b.seg 1) + ' s; nao prova o comportamento de 24 h')
    Write-Host '           (nem o volume real do DSH, que depende do churn real de processos).'
    $probsB = @($b.problemas)
    if ($probsB.Count -eq 0) { Write-Host 'MEDICAO: OK - sem resumo (teto de 150 MB nao atingido no periodo).' }
    else { foreach ($p in $probsB) { Write-Host ('PROBLEMA: ' + $p) } }
}

# Veredito da Rodada B
$bOk = $false
$bRazao = ''
if ($null -ne $b -and @($b.problemas).Count -eq 0) {
    $dayOk = $true
    if ($null -ne $b.usado_mb -and [double]$b.usado_mb -gt 150) { $dayOk = $false }
    if (-not $dayOk) {
        $bRazao = 'uso do dia passou de 150 MB (' + (Num $b.usado_mb 3) + ' MB)'
    } elseif ([double]$b.mb_dia -lt 200) {
        $bOk = $true
        $bRazao = 'extrapolacao ' + (Num $b.mb_dia 1) + ' MB/dia < 200 MB/dia e uso do dia ' + (Num $b.usado_mb 3) + ' MB <= 150 MB'
    } elseif ($capProven) {
        $bOk = $true
        $bRazao = 'extrapolacao ' + (Num $b.mb_dia 1) + ' MB/dia >= 200, mas o teto de ' + (Num $b.max_mb 1) + ' MB/dia (provado na Rodada A) trunca o uso real do dia em ' + (Num $b.max_mb 1) + ' MB (numero ruim, nao maquiado: ver AVISO acima)'
    } else {
        $bRazao = 'extrapolacao ' + (Num $b.mb_dia 1) + ' MB/dia >= 200 e teto diario NAO provado'
    }
}

Write-Host ''
if ($falhas.Count -eq 0 -and ($SkipMeasurement -or $bOk)) {
    Write-Host ('RESULTADO: PASS - teto diario provado (corte + resumo) e disco medido: ' + $(if ($null -ne $b) { (Num $b.mb_dia 1) + ' MB/dia extrapolado (' + $bRazao + ')' } else { 'medicao pulada' }))
    exit 0
} else {
    $motivos = New-Object System.Collections.ArrayList
    foreach ($f in $falhas) { $null = $motivos.Add($f) }
    if (-not $SkipMeasurement -and -not $bOk) { $null = $motivos.Add('Rodada B reprovada: ' + $bRazao) }
    Write-Host ('RESULTADO: FAIL - ' + ($motivos -join ' | '))
    exit 1
}
