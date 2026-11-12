# tests\test-captura-taskkill-real.ps1 - forwarder curto pedido pela issue #33.
# O teste de verdade fica na skill (skills\dsh-maintenance\tests\). Este arquivo
# existe so para o caminho literal "tests\test-captura-taskkill-real.ps1".
#
# RODAR (shell normal, fora do job restrito do agente):
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\test-captura-taskkill-real.ps1
#
# Repassa -RepoRoot e devolve o MESMO exit code do script da skill
# (0 = PASS 3/3, 1 = FAIL, 2 = pre-requisito ausente, 3 = SKIP).

[CmdletBinding()]
param([string]$RepoRoot = '')

$ErrorActionPreference = 'Stop'
if (-not $RepoRoot) { $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path

$alvo = Join-Path $RepoRoot 'skills\dsh-maintenance\tests\test-captura-taskkill-real.ps1'
if (-not (Test-Path -LiteralPath $alvo)) {
    Write-Host ('FAIL: script da skill ausente: ' + $alvo)
    exit 2
}

Write-Host ('forwarder -> ' + $alvo)
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $alvo -RepoRoot $RepoRoot
exit $LASTEXITCODE
