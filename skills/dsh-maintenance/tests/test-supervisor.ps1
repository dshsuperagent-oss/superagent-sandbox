# test-supervisor.ps1 - prova ExitCode + instante exato do processo supervisionado.
#
# NAO toca no DSH: supervisiona um processo descartavel (powershell -c Start-Sleep 300),
# encerra-o e verifica o registro em logs\supervisor-*.jsonl e
# logs\dsh-console-timestamped.log.
#
# Uso:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\skills\dsh-maintenance\tests\test-supervisor.ps1

[CmdletBinding()]
param(
    [string]$RepoRoot = '',
    [int]$TimeoutSec = 20
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot '_lib-test.ps1')
if (-not $RepoRoot) { $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path }

$skillRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$supScript = Join-Path $skillRoot 'scripts\supervisor-dsh.ps1'
if (-not (Test-Path -LiteralPath $supScript)) { Write-Host ('FAIL: supervisor ausente: ' + $supScript); exit 2 }

$dataDir = New-TestDataDir $RepoRoot 'supervisor'
$supPid = 0
$targetPid = 0
$falhas = @()

try {
    Write-TestStamp '1. config do alvo descartavel'
    $cfgPath = Join-Path $dataDir 'alvo.json'
    $cfg = [pscustomobject]@{
        exe     = 'powershell.exe'
        args    = @('-NoProfile', '-Command', 'Start-Sleep 300')
        workdir = $RepoRoot
    }
    $cfg | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $cfgPath -Encoding UTF8

    Write-TestStamp '2. iniciando supervisor-dsh.ps1'
    $sup = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $supScript, '-DataDir', $dataDir, '-ConfigPath', $cfgPath) -WindowStyle Hidden -PassThru
    $supPid = [int]$sup.Id
    Write-TestStamp ('   supervisor pid=' + $supPid)

    $statusFile = Wait-Until {
        Get-ChildItem -LiteralPath (Join-Path $dataDir 'logs') -Filter 'supervisor-status-*.json' -File -ErrorAction SilentlyContinue | Select-Object -First 1
    } $TimeoutSec 300
    if (-not $statusFile) { $falhas += 'status do supervisor nao apareceu'; throw 'sem status' }
    $status = Get-Content -LiteralPath $statusFile.FullName -Raw | ConvertFrom-Json
    $targetPid = [int]$status.target_pid
    Write-TestStamp ('   alvo supervisionado pid=' + $targetPid + ' runner=' + $status.runner_pid)
    if ($targetPid -le 0) { $falhas += 'target_pid invalido' }

    Start-Sleep -Seconds 2
    Write-TestStamp ('3. encerrando o alvo descartavel (pid ' + $targetPid + ') com Stop-Process')
    Stop-Process -Id $targetPid -Force -ErrorAction SilentlyContinue
    $null = Wait-Until { $sup.HasExited } $TimeoutSec 400
    if (-not $sup.HasExited) { $falhas += 'supervisor nao terminou' }

    $console = Join-Path $dataDir 'logs\dsh-console-timestamped.log'
    $jsonl = Get-ChildItem -LiteralPath (Join-Path $dataDir 'logs') -Filter 'supervisor-*.jsonl' -File -ErrorAction SilentlyContinue | Select-Object -First 1
    $logLines = @(Get-Content -LiteralPath $console -ErrorAction SilentlyContinue)
    $reg = $null
    if ($jsonl) { $reg = @(Get-Content -LiteralPath $jsonl.FullName -ErrorAction SilentlyContinue | ForEach-Object { try { $_ | ConvertFrom-Json } catch { } }) | Where-Object { $_.event -eq 'dsh_exit' } | Select-Object -First 1 }

    Write-Host ''
    Write-Host '== TRECHO dsh-console-timestamped.log =='
    $logLines | Select-Object -Last 6 | ForEach-Object { Write-Host $_ }
    Write-Host ''
    Write-Host '== TRECHO supervisor-*.jsonl =='
    if ($reg) { Write-Host ($reg | ConvertTo-Json -Compress -Depth 4) }

    $exitLine = $logLines | Where-Object { $_ -match '=== DSH EXIT code=-?\d+ em \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}' } | Select-Object -Last 1
    if (-not $exitLine) { $falhas += 'linha "=== DSH EXIT code=... em <timestamp> ===" ausente' }
    if ($null -eq $reg) { $falhas += 'registro dsh_exit ausente no supervisor-*.jsonl' }
    else {
        if ([int]$reg.exit_code -eq 0) { $falhas += 'exit_code=0 (esperado != 0 para processo morto)' }
        if (-not $reg.ts -or -not $reg.ended) { $falhas += 'instante da morte ausente' }
        if ([int]$reg.dsh_pid -ne $targetPid) { $falhas += 'dsh_pid do registro difere do alvo' }
    }
} finally {
    if ($supPid -gt 0) { try { Stop-Process -Id $supPid -Force -ErrorAction SilentlyContinue } catch { } }
    if ($targetPid -gt 0) { try { Stop-Process -Id $targetPid -Force -ErrorAction SilentlyContinue } catch { } }
}

Write-Host ''
if ($falhas.Count -eq 0) {
    Write-Host 'RESULTADO: PASS - ExitCode != 0 e instante exato registrados no log com timestamp.'
    exit 0
} else {
    Write-Host ('RESULTADO: FAIL - ' + ($falhas -join '; '))
    exit 1
}
