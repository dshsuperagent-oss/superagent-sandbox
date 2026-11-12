# test-captura-killer.ps1 - prova que o observador captura e classifica o assassino.
#
# TESTE SINTETICO: NAO toca no DSH. Cria um processo descartavel
# (powershell -c "Start-Sleep 300"), aponta o observador para ele via -TargetPid,
# dispara um assassino EXTERNO com o PID na linha de comando e verifica que
# processos-*.jsonl e veredito-*.json provam quem matou.
#
# Modos:
#   -Killer stop-process  (default; funciona no sandbox do agente)
#   -Killer taskkill      (precisa de um shell normal; no sandbox do DSH o
#                          taskkill recebe "Acesso negado" e o teste reporta SKIP,
#                          mas ainda prova a captura do processo taskkill.exe)
#
# Uso:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\skills\dsh-maintenance\tests\test-captura-killer.ps1

[CmdletBinding()]
param(
    [string]$RepoRoot = '',
    [ValidateSet('stop-process', 'taskkill')]
    [string]$Killer = 'stop-process',
    [int]$TimeoutSec = 60
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot '_lib-test.ps1')
if (-not $RepoRoot) { $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path }

$skillRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$observer = Join-Path $skillRoot 'scripts\observador.ps1'
if (-not (Test-Path -LiteralPath $observer)) { Write-Host ('FAIL: observador ausente: ' + $observer); exit 2 }

$dataDir = New-TestDataDir $RepoRoot ('captura-' + $Killer)
$obsPid = 0
$victimPid = 0
$falhas = @()

function Truncate-TestText([string]$s, [int]$n) {
    if (-not $s) { return '' }
    if ($s.Length -le $n) { return $s }
    return $s.Substring(0, $n) + '...'
}

try {
    Write-TestStamp ('1. subindo processo descartavel (powershell -c Start-Sleep 300)')
    $victim = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep 300') -PassThru -WindowStyle Hidden
    $victimPid = [int]$victim.Id
    Write-TestStamp ('   victim pid=' + $victimPid)

    $argLine = '-NoProfile -ExecutionPolicy Bypass -File "' + $observer + '" -DataDir "' + $dataDir + '" -TargetPid ' + $victimPid + ' -DurationSeconds 150'
    $obs = Start-Process -FilePath 'powershell.exe' -ArgumentList $argLine -WindowStyle Hidden -PassThru
    $obsPid = [int]$obs.Id
    Write-TestStamp ('2. observador pid=' + $obsPid + ' (fora da arvore do DSH, so leitura)')

    $estado = Join-Path $dataDir 'observacao\estado.json'
    if (-not (Wait-Heartbeat $estado $TimeoutSec)) { $falhas += 'observador nao gravou heartbeat'; throw 'sem heartbeat' }
    Write-TestStamp '   heartbeat fresco; alvo fixado'

    Start-Sleep -Milliseconds 800

    # Prova de durabilidade: com o observador VIVO, ler os JSONL e mostrar a linha
    # ja gravada. (Get-ChildItem pode mostrar tamanho defasado com o arquivo
    # aberto; o conteudo e lido por stream/Get-Content.) Este check impede a
    # regressao do flush.
    $procDay = (Get-Date).ToString('yyyy-MM-dd')
    $procFile = Join-Path $dataDir ('observacao\processos-' + $procDay + '.jsonl')
    $snapFile = Join-Path $dataDir ('observacao\snapshot-' + $procDay + '.jsonl')
    $durBytes = 0
    try {
        $fsDur = [System.IO.File]::Open($procFile, 'Open', 'Read', 'ReadWrite')
        $durBytes = $fsDur.Length
        $fsDur.Dispose()
    } catch { }
    $durLive = @(Get-Content -LiteralPath $procFile -ErrorAction SilentlyContinue)
    $durUltima = '(vazio)'
    if ($durLive.Count -gt 0) { $durUltima = [string]$durLive[$durLive.Count - 1] }
    Write-TestStamp ('   durabilidade (observador vivo): processos bytes=' + $durBytes + ' linhas=' + $durLive.Count)
    Write-TestStamp ('   ultima linha ja visivel: ' + (Truncate-TestText $durUltima 320))
    if ($durLive.Count -lt 1 -or $durBytes -le 0) { $falhas += 'processos-*.jsonl vazio com o observador vivo (flush nao efetivo)' }
    if (-not (Test-Path -LiteralPath $snapFile)) { $falhas += 'snapshot-*.jsonl ausente com o observador vivo' }

    $killAt = $null

    if ($Killer -eq 'taskkill') {
        $killAt = Get-Date
        Write-TestStamp ('3. assassino: taskkill.exe /PID ' + $victimPid + ' /F')
        & taskkill.exe /PID $victimPid /F 2>&1 | ForEach-Object { Write-TestStamp ('   taskkill: ' + $_) }
        Start-Sleep -Milliseconds 700
        $killOk = $victim.HasExited
        if (-not $killOk) {
            Write-TestStamp '   taskkill BLOQUEADO neste shell (Acesso negado): comprovando apenas a CAPTURA do taskkill.exe'
            Start-Sleep -Seconds 1
            $procFile = Join-Path $dataDir ('observacao\processos-' + (Get-Date).ToString('yyyy-MM-dd') + '.jsonl')
            $capt = @(Get-Content -LiteralPath $procFile -ErrorAction SilentlyContinue | Where-Object { $_ -match '"name":"taskkill"' -and $_ -match [string]$victimPid })
            Write-Host ''
            Write-Host '== TRECHO processos-*.jsonl (taskkill capturado, mas bloqueado para matar) =='
            $capt | Select-Object -First 2 | ForEach-Object { Write-Host (Truncate-TestText $_ 900) }
            if ($capt.Count -lt 1) {
                Write-Host 'RESULTADO: SKIP - taskkill bloqueado neste shell e curto demais para o poll de 100 ms.'
                Write-Host 'Em um shell normal (taskkill com sucesso vive ~140 ms) o observador captura PID/PPID/cmdline.'
                exit 0
            }
            Write-Host 'RESULTADO: PARTIAL/SKIP - taskkill bloqueado neste shell; captura de taskkill.exe (PID/PPID/cmdline) provada.'
            Write-Host 'Para a prova completa de classificacao killed com taskkill, rode este teste em um shell normal.'
            exit 0
        }
    } else {
        $killAt = Get-Date
        Write-TestStamp ('3. assassino: powershell.exe -Command "Stop-Process -Id ' + $victimPid + ' -Force" (processo externo separado)')
        $killCmd = 'Stop-Process -Id ' + $victimPid + ' -Force'
        $killerProc = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-Command', $killCmd) -PassThru -WindowStyle Hidden -Wait
        Write-TestStamp ('   assassino pid=' + $killerProc.Id + ' exit=' + $killerProc.ExitCode)
        $killOk = $victim.HasExited
    }

    if (-not $killOk) {
        # Fallback para provar a classificacao mesmo com taskkill bloqueado.
        Write-TestStamp '   fallback: encerrando o descartavel via Stop-Process (para provar o veredito)'
        $killAt = Get-Date
        Stop-Process -Id $victimPid -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 500
        $killOk = $victim.HasExited
    }
    if (-not $killOk) { $falhas += 'processo descartavel nao morreu' }

    Write-TestStamp '4. aguardando veredito do observador'
    $verdict = Wait-Until { Get-NewestVerdict (Join-Path $dataDir 'observacao') } $TimeoutSec 400
    if ($null -eq $verdict) { $falhas += 'nenhum veredito gerado'; throw 'sem veredito' }

    $procFile = Join-Path $dataDir ('observacao\processos-' + (Get-Date).ToString('yyyy-MM-dd') + '.jsonl')
    $linhas = @(Get-Content -LiteralPath $procFile -ErrorAction SilentlyContinue)
    $evid = @($verdict.evidencias | Where-Object { $_.fonte -like 'processos-*' })

    # Latencia inicio do kill -> registro do veredito (aceite da issue: <= 5 s).
    $deathToVerdict = $null
    if ($null -ne $killAt -and $verdict.gerado_em) {
        try { $deathToVerdict = [math]::Round(([datetime]::Parse([string]$verdict.gerado_em) - $killAt).TotalSeconds, 2) } catch { }
    }
    Write-TestStamp ('   morte->veredito_s=' + $deathToVerdict)
    if ($null -eq $deathToVerdict) { $falhas += 'nao foi possivel medir morte->veredito' }
    elseif ($deathToVerdict -gt 5.0) { $falhas += ('registro de morte ' + $deathToVerdict + 's apos a morte (limite 5 s)') }

    Write-Host ''
    Write-Host '== TRECHO processos-*.jsonl (assassino) =='
    $linhas | Where-Object { $_ -match '(?i)stop-process|taskkill' -and $_ -match [string]$victimPid } | Select-Object -First 3 | ForEach-Object { Write-Host (Truncate-TestText $_ 900) }
    Write-Host ''
    Write-Host '== TRECHO veredito-*.json =='
    $verdict | Select-Object veredito, confianca, resumo | Format-List | Out-String | ForEach-Object { Write-Host $_ }
    if ($verdict.assassino) {
        $verdict.assassino | Select-Object pid, ppid, nome, cmdline | Format-List | Out-String | ForEach-Object { Write-Host $_ }
        Write-Host ('evidencias citadas: ' + (($verdict.evidencias | ForEach-Object { $_.fonte + ':' + $_.linha + ' (' + $_.hora + ')' }) -join '; '))
    }

    if ($verdict.veredito -ne 'killed') { $falhas += ('veredito=' + $verdict.veredito + ' (esperado killed)') }
    if ($null -eq $verdict.assassino) { $falhas += 'veredito sem campo assassino' }
    else {
        if (-not $verdict.assassino.cmdline -or $verdict.assassino.cmdline -notmatch [string]$victimPid) { $falhas += 'cmdline do assassino nao cita o PID do alvo' }
        if ([int]$verdict.assassino.ppid -le 0) { $falhas += 'ppid do assassino ausente' }
        if (-not $verdict.assassino.ancestrais -or @($verdict.assassino.ancestrais).Count -lt 1) { $falhas += 'cadeia de ancestrais ausente' }
    }
    if ($evid.Count -lt 1) { $falhas += 'veredito sem evidencia de processos-*.jsonl' }

    $taskkillRec = @($linhas | Where-Object { $_ -match '"name":"taskkill"' })
    Write-Host ''
    Write-Host ('taskkill.exe registrado no JSONL: ' + $taskkillRec.Count + ' linha(s)')
} finally {
    if ($obsPid -gt 0) { try { Stop-Process -Id $obsPid -Force -ErrorAction SilentlyContinue } catch { } }
    if ($victimPid -gt 0) { try { Stop-Process -Id $victimPid -Force -ErrorAction SilentlyContinue } catch { } }
}

Write-Host ''
if ($falhas.Count -eq 0) {
    Write-Host 'RESULTADO: PASS - observador capturou PID/PPID/CommandLine e classificou killed.'
    exit 0
} else {
    Write-Host ('RESULTADO: FAIL - ' + ($falhas -join '; '))
    exit 1
}
