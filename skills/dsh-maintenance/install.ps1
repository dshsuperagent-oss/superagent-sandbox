# install.ps1 - instala o observador dsh-maintenance (sem admin, idempotente).
#
# O que faz:
#   1. copia os scripts para <InstallDir>\scripts;
#   2. cria/atualiza as entradas de Startup do usuario:
#        "DSH - observador 3080.cmd"            -> observador.ps1
#        "DSH - supervisor observador 3080.cmd" -> supervisor-observador.ps1
#   3. encerra apenas instancias ANTERIORES do proprio observador/supervisor;
#   4. sobe observador + supervisor e comprova com o heartbeat e as 3 primeiras
#      linhas de cada arquivo JSONL.
#
# NUNCA toca no DSH, na porta 3080, no watchdog-3080.ps1 nem em outro processo.
# Rodar 2x nao duplica Startup nem processos (mesmos nomes de arquivo + mutex).

[CmdletBinding()]
param(
    [string]$InstallDir = 'F:\ai\_lab\dsh-saude\observador',
    [string]$StartupDir = (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'),
    [int]$StartWaitSec = 30,
    [switch]$NoStart,
    [switch]$SuperviseDsh
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'scripts\lib.ps1')

$srcScripts = Join-Path $PSScriptRoot 'scripts'
$required = @('lib.ps1', 'captura.ps1', 'observador.ps1', 'supervisor-observador.ps1', 'supervisor-dsh.ps1', 'supervisor-runner.ps1')
$missing = @()
foreach ($f in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $srcScripts $f))) { $missing += $f }
}
if ($missing.Count -gt 0) {
    Write-Host ('ERRO: scripts ausentes em ' + $srcScripts + ': ' + ($missing -join ', '))
    exit 2
}

$destScripts = Join-Path $InstallDir 'scripts'
$obsDir = Join-Path $InstallDir 'observacao'
$logDir = Join-Path $InstallDir 'logs'
foreach ($d in @($InstallDir, $destScripts, $obsDir, $logDir, $StartupDir)) {
    if (-not (Test-Path -LiteralPath $d)) { $null = New-Item -ItemType Directory -Force -Path $d }
}

Write-Host '== dsh-maintenance install =='
Write-Host ('origem : ' + $srcScripts)
Write-Host ('destino: ' + $InstallDir)
Write-Host ('startup: ' + $StartupDir)

# 1. Encerra apenas instancias anteriores DOS NOSSOS scripts (nunca o DSH).
$stops = @()
$stops += @(Stop-OwnScriptProcesses $InstallDir 'observador.ps1')
$stops += @(Stop-OwnScriptProcesses $InstallDir 'supervisor-observador.ps1')
if ($stops.Count -gt 0) {
    Write-Host ('instancias anteriores encerradas: ' + ($stops -join ', '))
    Start-Sleep -Milliseconds 800
} else {
    Write-Host 'nenhuma instancia anterior dos nossos scripts estava rodando'
}

# 2. Copia os scripts (sobrescreve = idempotente).
foreach ($f in $required) {
    Copy-Item -LiteralPath (Join-Path $srcScripts $f) -Destination (Join-Path $destScripts $f) -Force
}
$readme = Join-Path $PSScriptRoot 'README.md'
if (Test-Path -LiteralPath $readme) {
    Copy-Item -LiteralPath $readme -Destination (Join-Path $InstallDir 'README.md') -Force
}
Write-Host ('scripts copiados: ' + ($required -join ', '))

# 3. Startup do usuario (dois .cmd; conteudo estavel para nao duplicar).
$obsScript = Join-Path $destScripts 'observador.ps1'
$supScript = Join-Path $destScripts 'supervisor-observador.ps1'

$startupObs = Join-Path $StartupDir 'DSH - observador 3080.cmd'
$startupSup = Join-Path $StartupDir 'DSH - supervisor observador 3080.cmd'
$startupDsh = Join-Path $StartupDir 'DSH - supervisor-dsh 3080.cmd'

$contentObs = @(
    '@echo off',
    'rem Observador permanente do DSH (porta 3080). NUNCA mata o DSH.',
    ('start "" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $obsScript + '" -DataDir "' + $InstallDir + '"')
) -join "`r`n"
$contentSup = @(
    '@echo off',
    'rem Supervisor do observador do DSH. Reergue o observador se o heartbeat parar.',
    ('start "" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $supScript + '" -DataDir "' + $InstallDir + '"')
) -join "`r`n"

[System.IO.File]::WriteAllText($startupObs, $contentObs, (New-Object System.Text.UTF8Encoding($false)))
[System.IO.File]::WriteAllText($startupSup, $contentSup, (New-Object System.Text.UTF8Encoding($false)))

# Opcional: entrada que sobe o DSH SOB o supervisor-dsh no logon. Usa -OnlyIfDown
# para nunca duplicar o servidor se o boot script existente ja subiu.
if ($SuperviseDsh) {
    $contentDsh = @(
        '@echo off',
        'rem Sobe o DSH sob supervisor-dsh (grava ExitCode + instante). Nao mata nada.',
        ('start "" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $destScripts 'supervisor-dsh.ps1') + '" -DataDir "' + $InstallDir + '" -OnlyIfDown')
    ) -join "`r`n"
    [System.IO.File]::WriteAllText($startupDsh, $contentDsh, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host ('startup extra: ' + (Split-Path $startupDsh -Leaf) + ' (-OnlyIfDown)')
} else {
    if (Test-Path -LiteralPath $startupDsh) {
        Remove-Item -LiteralPath $startupDsh -Force -ErrorAction SilentlyContinue
        Write-Host 'startup antigo removido: DSH - supervisor-dsh 3080.cmd'
    }
}

# Remove variantes antigas dos NOSSOS arquivos (evita duplicata de versoes passadas).
foreach ($f in Get-ChildItem -LiteralPath $StartupDir -File -ErrorAction SilentlyContinue) {
    if ($f.FullName -eq $startupObs -or $f.FullName -eq $startupSup -or $f.FullName -eq $startupDsh) { continue }
    if ($f.Name -match '^(?i)DSH - observador.*\.cmd$' -or $f.Name -match '^(?i)DSH - supervisor observador.*\.cmd$' -or $f.Name -match '^(?i)DSH - supervisor-dsh.*\.cmd$') {
        Remove-Item -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue
        Write-Host ('startup antigo removido: ' + $f.Name)
    }
}
Write-Host ('startup: ' + (Split-Path $startupObs -Leaf) + ' + ' + (Split-Path $startupSup -Leaf))
if (Test-Path -LiteralPath $startupDsh) { Write-Host ('startup extra: ' + (Split-Path $startupDsh -Leaf)) }

if ($NoStart) {
    Write-Host '-NoStart: nao iniciado; conteudo instalado e verificado por leitura.'
    Write-Host 'OK (sem start)'
    exit 0
}

# 4. Sobe o observador, espera o primeiro heartbeat e so entao sobe o supervisor.
$argObs = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $obsScript + '" -DataDir "' + $InstallDir + '"'
$argSup = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $supScript + '" -DataDir "' + $InstallDir + '"'
$pObs = Start-Process -FilePath 'powershell.exe' -ArgumentList $argObs -WindowStyle Hidden -PassThru
Write-Host ('observador iniciado pid=' + $pObs.Id)

$estadoPath = Join-Path $obsDir 'estado.json'
$deadline = (Get-Date).AddSeconds($StartWaitSec)
$estado = $null
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    $estado = Read-JsonFile $estadoPath
    if ($null -ne $estado -and $estado.ultimo_ciclo) {
        try {
            $age = ((Get-Date) - [datetime]::Parse([string]$estado.ultimo_ciclo)).TotalSeconds
            if ($age -lt 20) { break }
        } catch { }
    }
}

$pSup = Start-Process -FilePath 'powershell.exe' -ArgumentList $argSup -WindowStyle Hidden -PassThru
Write-Host ('supervisor iniciado pid=' + $pSup.Id)
Start-Sleep -Seconds 3

# 5. Comprova heartbeat e arquivos (nova leitura depois do supervisor).

$falhas = @()
if ($null -eq $estado) { $falhas += 'estado.json ausente' }
else {
    try {
        $age = ((Get-Date) - [datetime]::Parse([string]$estado.ultimo_ciclo)).TotalSeconds
        if ($age -ge 20) { $falhas += ('heartbeat velho (' + [math]::Round($age, 0) + 's)') }
    } catch { $falhas += 'estado.json ilegivel' }
}

$files = @(
    (Join-Path $obsDir ('snapshot-' + (Get-Date).ToString('yyyy-MM-dd') + '.jsonl')),
    (Join-Path $obsDir ('processos-' + (Get-Date).ToString('yyyy-MM-dd') + '.jsonl')),
    (Join-Path $obsDir ('eventos-' + (Get-Date).ToString('yyyy-MM-dd') + '.jsonl')),
    (Join-Path $obsDir ('hash-sessoes-' + (Get-Date).ToString('yyyy-MM-dd') + '.jsonl'))
)
foreach ($f in $files) {
    $n = Get-LineCount $f
    if ($n -lt 1) { $falhas += ('sem linhas: ' + (Split-Path $f -Leaf)) }
}

# Contagem de instancias (nao pode duplicar).
function Get-OwnPids([string]$dir, [string]$pattern) {
    $out = @()
    try {
        foreach ($p in [System.Diagnostics.Process]::GetProcesses()) {
            $id = 0
            try {
                if ($p.ProcessName -notmatch '^(powershell|pwsh)$') { continue }
                $id = [int]$p.Id
            } catch { continue } finally { try { $p.Dispose() } catch { } }
            if ($id -le 0) { continue }
            $d = Get-PebInfo $id
            if ($d.ok -and $d.cmdline -like "*$dir*" -and $d.cmdline -match $pattern) { $out += $id }
        }
    } catch { }
    return $out
}
$obsPids = @(Get-OwnPids $InstallDir '\\observador\.ps1')
$supPids = @(Get-OwnPids $InstallDir '\\supervisor-observador\.ps1')
if ($obsPids.Count -ne 1) { $falhas += ('observador: ' + $obsPids.Count + ' instancia(s) (esperado 1)') }
if ($supPids.Count -ne 1) { $falhas += ('supervisor: ' + $supPids.Count + ' instancia(s) (esperado 1)') }

Write-Host ('observador pids: ' + ($obsPids -join ', ') + ' | supervisor pids: ' + ($supPids -join ', '))

# 6. Prova: 3 primeiras linhas de cada arquivo.
foreach ($f in $files) {
    Write-Host ''
    Write-Host ('== PROVA ' + (Split-Path $f -Leaf) + ' (' + (Get-LineCount $f) + ' linhas) ==')
    if (Test-Path -LiteralPath $f) {
        Get-Content -LiteralPath $f -TotalCount 3 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host (Truncate-Text ([string]$_) 700) }
    } else {
        Write-Host '(arquivo ausente)'
    }
}
Write-Host ''
Write-Host '== PROVA estado.json =='
if (Test-Path -LiteralPath $estadoPath) {
    (Get-Content -LiteralPath $estadoPath -Raw) -split "`r?`n" | Select-Object -First 3 | ForEach-Object { Write-Host $_ }
} else {
    Write-Host '(ausente)'
}
Write-Host ''
Write-Host '== PROVA Startup =='
Write-Host $startupObs
Get-Content -LiteralPath $startupObs -ErrorAction SilentlyContinue | ForEach-Object { Write-Host ('  ' + $_) }
Write-Host $startupSup
Get-Content -LiteralPath $startupSup -ErrorAction SilentlyContinue | ForEach-Object { Write-Host ('  ' + $_) }

if ($falhas.Count -gt 0) {
    Write-Host ''
    Write-Host ('FALHAS: ' + ($falhas -join '; '))
    Write-Host ('dica: veja ' + (Join-Path $logDir ('observador-' + (Get-Date).ToString('yyyy-MM-dd') + '.log')))
    exit 1
}

Write-Host ''
Write-Host ('OK: observador e supervisor ativos, heartbeat fresco, arquivos gravando. DSH intocado (porta ' + 3080 + ').')
exit 0
