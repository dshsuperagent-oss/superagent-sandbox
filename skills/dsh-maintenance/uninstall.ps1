# uninstall.ps1 - reverte a instalacao do observador dsh-maintenance.
#
# - encerra APENAS observador.ps1 e supervisor-observador.ps1 instalados em InstallDir;
# - remove as entradas de Startup criadas pelo install.ps1;
# - mantem observacao\ e logs\ (historico) para analise posterior.
# NUNCA toca no DSH, na porta 3080 nem no watchdog-3080.ps1.

[CmdletBinding()]
param(
    [string]$InstallDir = 'F:\ai\_lab\dsh-saude\observador',
    [string]$StartupDir = (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup')
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'scripts\lib.ps1')

Write-Host '== dsh-maintenance uninstall =='
Write-Host ('install dir: ' + $InstallDir)

$stops = @()
$stops += @(Stop-OwnScriptProcesses $InstallDir 'observador.ps1')
$stops += @(Stop-OwnScriptProcesses $InstallDir 'supervisor-observador.ps1')
if ($stops.Count -gt 0) {
    Write-Host ('processos encerrados: ' + ($stops -join ', '))
} else {
    Write-Host 'nenhum processo do observador/supervisor estava rodando'
}

$startupObs = Join-Path $StartupDir 'DSH - observador 3080.cmd'
$startupSup = Join-Path $StartupDir 'DSH - supervisor observador 3080.cmd'
$startupDsh = Join-Path $StartupDir 'DSH - supervisor-dsh 3080.cmd'
foreach ($f in @($startupObs, $startupSup, $startupDsh)) {
    if (Test-Path -LiteralPath $f) {
        Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue
        Write-Host ('startup removido: ' + (Split-Path $f -Leaf))
    }
}

$obsDir = Join-Path $InstallDir 'observacao'
$logDir = Join-Path $InstallDir 'logs'
Write-Host ''
Write-Host 'dados mantidos (nao apagados):'
if (Test-Path -LiteralPath $obsDir) {
    $n = @(Get-ChildItem -LiteralPath $obsDir -File -ErrorAction SilentlyContinue).Count
    Write-Host ('  ' + $obsDir + ' (' + $n + ' arquivos)')
}
if (Test-Path -LiteralPath $logDir) {
    $n = @(Get-ChildItem -LiteralPath $logDir -File -ErrorAction SilentlyContinue).Count
    Write-Host ('  ' + $logDir + ' (' + $n + ' arquivos)')
}
Write-Host ''
Write-Host 'OK: observador desinstalado; DSH intocado.'
exit 0
