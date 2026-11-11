# test-install.ps1 - prova que o install.ps1 e idempotente (2x) e que o uninstall reverte.
#
# Usa diretorios de teste dentro do repo (-InstallDir/-StartupDir) para nao
# escrever na instalacao real e NAO toca no DSH.
#
# Uso:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\skills\dsh-maintenance\tests\test-install.ps1

[CmdletBinding()]
param(
    [string]$RepoRoot = '',
    [int]$StartWaitSec = 25
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot '_lib-test.ps1')
if (-not $RepoRoot) { $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path }

$skillRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$install = Join-Path $skillRoot 'install.ps1'
$uninstall = Join-Path $skillRoot 'uninstall.ps1'
if (-not (Test-Path -LiteralPath $install)) { Write-Host ('FAIL: install.ps1 ausente: ' + $install); exit 2 }

$base = Join-Path $RepoRoot '.out\install'
if (Test-Path -LiteralPath $base) { Remove-Item -LiteralPath $base -Recurse -Force }
$installDir = Join-Path $base 'observador'
$startupDir = Join-Path $base 'startup'
$null = New-Item -ItemType Directory -Force -Path $startupDir
$falhas = @()

function Invoke-InstallOnce([int]$n) {
    Write-TestStamp ('== install run ' + $n + ' ==')
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $install -InstallDir $installDir -StartupDir $startupDir -StartWaitSec $StartWaitSec 2>&1
    $code = $LASTEXITCODE
    $out | Where-Object { $_ -match 'PROVA|observador pids|supervisor pids|OK:|FALHAS|iniciado|startup:|scripts copiados|instancias anteriores|nenhuma instancia|EXIT' } | ForEach-Object { Write-Host $_ }
    Write-Host ('EXIT=' + $code)
    return [pscustomobject]@{ Code = $code; Output = $out }
}

try {
    $r1 = Invoke-InstallOnce 1
    if ($r1.Code -ne 0) { $falhas += 'install run 1 retornou ' + $r1.Code }
    $startup1 = @(Get-ChildItem -LiteralPath $startupDir -File -Filter '*.cmd')
    if ($startup1.Count -ne 2) { $falhas += ('run 1: ' + $startup1.Count + ' arquivos na Startup (esperado 2)') }

    Start-Sleep -Seconds 2
    $r2 = Invoke-InstallOnce 2
    if ($r2.Code -ne 0) { $falhas += 'install run 2 retornou ' + $r2.Code }
    $startup2 = @(Get-ChildItem -LiteralPath $startupDir -File -Filter '*.cmd')
    if ($startup2.Count -ne 2) { $falhas += ('run 2: ' + $startup2.Count + ' arquivos na Startup (esperado 2)') }

    $obsPids = @()
    $supPids = @()
    foreach ($line in $r2.Output) {
        if ($line -match 'observador pids:\s*([\d, ]+)') { $obsPids = @((($Matches[1]) -split ',') | Where-Object { $_.Trim() } | ForEach-Object { [int]$_.Trim() }) }
        if ($line -match 'supervisor pids:\s*([\d, ]+)') { $supPids = @((($Matches[1]) -split ',') | Where-Object { $_.Trim() } | ForEach-Object { [int]$_.Trim() }) }
    }
    Write-Host ('contagem final: observador=' + $obsPids.Count + ' supervisor=' + $supPids.Count)
    if ($obsPids.Count -ne 1) { $falhas += ('observador: ' + $obsPids.Count + ' instancia(s) apos 2x (esperado 1)') }
    if ($supPids.Count -ne 1) { $falhas += ('supervisor: ' + $supPids.Count + ' instancia(s) apos 2x (esperado 1)') }

    if ($r2.Output -match 'FALHAS') { $falhas += 'install run 2 reportou FALHAS' }

    Write-Host ''
    Write-Host '== Startup (deve ter exatamente 2 arquivos, sem duplicata) =='
    $startup2 | Select-Object Name, Length | Format-Table -AutoSize | Out-String | ForEach-Object { Write-Host $_ }

    Write-TestStamp '== uninstall =='
    $uout = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $uninstall -InstallDir $installDir -StartupDir $startupDir 2>&1
    $ucode = $LASTEXITCODE
    $uout | ForEach-Object { Write-Host $_ }
    if ($ucode -ne 0) { $falhas += 'uninstall retornou ' + $ucode }
    $startup3 = @(Get-ChildItem -LiteralPath $startupDir -File -Filter '*.cmd' -ErrorAction SilentlyContinue)
    if ($startup3.Count -ne 0) { $falhas += ('uninstall deixou ' + $startup3.Count + ' arquivo(s) na Startup') }
    if (-not (Test-Path -LiteralPath (Join-Path $installDir 'observacao'))) { $falhas += 'uninstall apagou observacao (deveria manter)' }
} finally {
    # Garante que nenhum processo de teste fique rodando.
    $cleanup = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $uninstall -InstallDir $installDir -StartupDir $startupDir 2>&1
    $null = $cleanup
}

Write-Host ''
if ($falhas.Count -eq 0) {
    Write-Host 'RESULTADO: PASS - install 2x sem duplicar Startup/processos; uninstall removeu Startup e manteve dados.'
    exit 0
} else {
    Write-Host ('RESULTADO: FAIL - ' + ($falhas -join '; '))
    exit 1
}
