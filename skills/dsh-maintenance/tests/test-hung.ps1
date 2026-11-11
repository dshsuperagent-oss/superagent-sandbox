# test-hung.ps1 - prova a classificacao `hung` (porta aberta, HTTP sem resposta).
#
# Sobe um servidor TCP que aceita conexao e NUNCA responde, aponta o observador
# para ele (-Port <porta de teste> -TargetPid <pid do node>) e verifica que depois
# de >20 s sem resposta sai um veredito `hung` com confianca alta.
#
# NAO toca no DSH: usa uma porta alta (38080) e um processo node descartavel.
#
# Uso:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\skills\dsh-maintenance\tests\test-hung.ps1

[CmdletBinding()]
param(
    [string]$RepoRoot = '',
    [int]$Port = 38080,
    [int]$TimeoutSec = 45
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot '_lib-test.ps1')
if (-not $RepoRoot) { $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path }

$skillRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$observer = Join-Path $skillRoot 'scripts\observador.ps1'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Host 'RESULTADO: SKIP - node.exe nao encontrado'; exit 0 }

$dataDir = New-TestDataDir $RepoRoot 'hung'
$srvJs = Join-Path $env:TEMP ('dsh-hang-' + $PID + '.js')
$nodeProc = $null
$obsPid = 0
$falhas = @()

try {
    Set-Content -LiteralPath $srvJs -Encoding ASCII -Value ("const net=require('net');const s=net.createServer(function(c){});s.listen(" + $Port + ",'127.0.0.1',function(){console.log('listening')});")

    Write-TestStamp ('1. servidor TCP mudo na porta ' + $Port)
    $nodeProc = Start-Process -FilePath $node.Source -ArgumentList @($srvJs) -PassThru -WindowStyle Hidden
    Start-Sleep -Seconds 1
    if ($nodeProc.HasExited) { throw 'node nao subiu' }
    Write-TestStamp ('   node pid=' + $nodeProc.Id)

    Write-TestStamp '2. observador apontado para a porta de teste'
    $obsArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $observer, '-DataDir', $dataDir, '-Port', $Port, '-TargetPid', $nodeProc.Id, '-DurationSeconds', 50)
    $obs = Start-Process -FilePath 'powershell.exe' -ArgumentList $obsArgs -WindowStyle Hidden -PassThru
    $obsPid = [int]$obs.Id
    if (-not (Wait-Heartbeat (Join-Path $dataDir 'observacao\estado.json') 15)) { throw 'sem heartbeat' }

    Write-TestStamp '3. aguardando veredito hung (>20 s sem resposta)'
    $verdict = Wait-Until { Get-NewestVerdict (Join-Path $dataDir 'observacao') } $TimeoutSec 500
    if ($null -eq $verdict) { $falhas += 'nenhum veredito gerado' }
    else {
        Write-Host ''
        Write-Host '== TRECHO veredito-*.json =='
        $verdict | Select-Object veredito, confianca, resumo | Format-List | Out-String | ForEach-Object { Write-Host $_ }
        if ($verdict.veredito -ne 'hung') { $falhas += ('veredito=' + $verdict.veredito + ' (esperado hung)') }
        if ($verdict.confianca -ne 'alta') { $falhas += ('confianca=' + $verdict.confianca + ' (esperado alta)') }
    }
} finally {
    if ($obsPid -gt 0) { try { Stop-Process -Id $obsPid -Force -ErrorAction SilentlyContinue } catch { } }
    if ($nodeProc -and -not $nodeProc.HasExited) { try { Stop-Process -Id $nodeProc.Id -Force -ErrorAction SilentlyContinue } catch { } }
    Remove-Item -LiteralPath $srvJs -Force -ErrorAction SilentlyContinue
}

Write-Host ''
if ($falhas.Count -eq 0) {
    Write-Host 'RESULTADO: PASS - classificacao hung (porta aberta, HTTP sem resposta >20s) com confianca alta.'
    exit 0
} else {
    Write-Host ('RESULTADO: FAIL - ' + ($falhas -join '; '))
    exit 1
}
