# test-rotacao.ps1 - prova rotacao diaria e retencao dos JSONL.
#
# Usa -ForceDate para simular dois dias e -RetentionDays para provar que arquivos
# antigos sao removidos. NAO toca no DSH.
#
# Uso:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\skills\dsh-maintenance\tests\test-rotacao.ps1

[CmdletBinding()]
param(
    [string]$RepoRoot = ''
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot '_lib-test.ps1')
if (-not $RepoRoot) { $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path }

$skillRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$observer = Join-Path $skillRoot 'scripts\observador.ps1'
$dataDir = New-TestDataDir $RepoRoot 'rotacao'
$falhas = @()

function Invoke-ObserverDay([string]$Day) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $observer -DataDir $dataDir -ForceDate $Day -RetentionDays 1 -DurationSeconds 4 2>&1 | Out-Null
}

try {
    Write-TestStamp '1. simulando 2026-11-01 (retencao 1 dia)'
    Invoke-ObserverDay '2026-11-01'
    $obs = Join-Path $dataDir 'observacao'
    $oldSnapshot = Join-Path $obs 'snapshot-2026-11-01.jsonl'
    foreach ($cat in @('snapshot', 'processos', 'eventos', 'hash-sessoes')) {
        $f = Join-Path $obs ($cat + '-2026-11-01.jsonl')
        if (-not (Test-Path -LiteralPath $f)) { $falhas += ('arquivo do dia 2026-11-01 ausente: ' + $cat) }
    }
    Write-TestStamp ('   arquivos do dia 01: ' + @(Get-ChildItem -LiteralPath $obs -Filter '*-2026-11-01.jsonl').Count)

    Write-TestStamp '2. simulando 2026-11-11 (retencao 1 dia) - deve apagar 2026-11-01'
    Invoke-ObserverDay '2026-11-11'
    $newSnapshot = Join-Path $obs 'snapshot-2026-11-11.jsonl'
    if (-not (Test-Path -LiteralPath $newSnapshot)) { $falhas += 'arquivo do dia 2026-11-11 ausente' }
    if (Test-Path -LiteralPath $oldSnapshot) { $falhas += 'arquivo de 2026-11-01 NAO foi removido pela retencao' }

    Write-Host ''
    Write-Host '== LISTAGEM observacao\ apos os dois dias =='
    Get-ChildItem -LiteralPath $obs -File | Sort-Object Name | Select-Object Name, Length | Format-Table -AutoSize | Out-String | ForEach-Object { Write-Host $_ }

    $log = Get-ChildItem -LiteralPath (Join-Path $dataDir 'logs') -Filter 'observador-*.log' | Select-Object -First 1
    if ($log) {
        Write-Host '== TRECHO log do observador (retencao) =='
        Get-Content -LiteralPath $log.FullName | Where-Object { $_ -match 'retencao|iniciado|encerrado' } | ForEach-Object { Write-Host $_ }
        if (-not (@(Get-Content -LiteralPath $log.FullName) | Where-Object { $_ -match 'retencao removeu' })) {
            $falhas += 'log nao registrou a remocao por retencao'
        }
    }
} finally {
    # nada a encerrar: o observador roda com -DurationSeconds e sai sozinho
}

Write-Host ''
if ($falhas.Count -eq 0) {
    Write-Host 'RESULTADO: PASS - rotacao por dia e retencao funcionando.'
    exit 0
} else {
    Write-Host ('RESULTADO: FAIL - ' + ($falhas -join '; '))
    exit 1
}
