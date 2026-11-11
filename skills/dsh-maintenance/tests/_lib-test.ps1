# _lib-test.ps1 - utilitarios dos testes da skill dsh-maintenance (ASCII puro).
$ErrorActionPreference = 'Continue'

function Wait-Until {
    param(
        [scriptblock]$Condition,
        [int]$TimeoutSec = 20,
        [int]$IntervalMs = 250
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $r = $null
        try { $r = & $Condition } catch { $r = $null }
        if ($r) { return $r }
        Start-Sleep -Milliseconds $IntervalMs
    }
    return $null
}

function Wait-File([string]$Path, [int]$TimeoutSec = 20) {
    return [bool](Wait-Until { Test-Path -LiteralPath $Path } $TimeoutSec 250)
}

function Wait-Heartbeat([string]$EstadoPath, [int]$TimeoutSec = 20) {
    return [bool](Wait-Until {
            try {
                if (-not (Test-Path -LiteralPath $EstadoPath)) { return $false }
                $e = (Get-Content -LiteralPath $EstadoPath -Raw) | ConvertFrom-Json
                if (-not $e.ultimo_ciclo) { return $false }
                return (((Get-Date) - [datetime]::Parse([string]$e.ultimo_ciclo)).TotalSeconds -lt 10)
            } catch { return $false }
        } $TimeoutSec 300)
}

function Get-NewestVerdict([string]$ObsDir) {
    $f = Get-ChildItem -LiteralPath $ObsDir -Filter 'veredito-*.json' -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $f) { return $null }
    return (Get-Content -LiteralPath $f.FullName -Raw | ConvertFrom-Json)
}

function New-TestDataDir([string]$Root, [string]$Name) {
    $d = Join-Path $Root ('.out\' + $Name)
    if (Test-Path -LiteralPath $d) { Remove-Item -LiteralPath $d -Recurse -Force }
    $null = New-Item -ItemType Directory -Force -Path $d
    return $d
}

function Write-TestStamp([string]$Text) {
    Write-Host ('[' + (Get-Date).ToString('HH:mm:ss') + '] ' + $Text)
}
