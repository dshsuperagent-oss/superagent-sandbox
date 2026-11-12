# supervisor-runner.ps1 - inicia o DSH, timestampa stdout+stderr e devolve o ExitCode.
# Usado por supervisor-dsh.ps1. Nao reinicia nada e nao mata nada.
#
# Recebe um JSON de configuracao:
#   { exe, args[], workdir, log, exitFile, statusFile }
# Sai com o ExitCode do processo supervisionado.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ConfigPath
)

$ErrorActionPreference = 'Continue'

$cfg = $null
try {
    $raw = [System.IO.File]::ReadAllText($ConfigPath, [System.Text.Encoding]::UTF8)
    $cfg = $raw | ConvertFrom-Json
} catch {
    Write-Error ('config invalida: ' + $_.Exception.Message)
    exit 2
}

$log = [string]$cfg.log
$started = Get-Date

function Add-Log([string]$text) {
    try { Add-Content -LiteralPath $log -Value $text -Encoding UTF8 } catch { }
}

function Read-NewLines([string]$Path, [string]$Side) {
    $lines = @()
    if (-not (Test-Path -LiteralPath $Path)) { return $lines }
    $posVar = if ($Side -eq 'out') { 'OutPos' } else { 'ErrPos' }
    $bufVar = if ($Side -eq 'out') { 'OutBuf' } else { 'ErrBuf' }
    try {
        $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, ([System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete))
        try {
            $offset = [long](Get-Variable -Name $posVar -Scope script -ValueOnly)
            if ($fs.Length -lt $offset) { $offset = 0 }
            $fs.Position = $offset
            $sr = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)
            $text = $sr.ReadToEnd()
            $offset = $fs.Position
            Set-Variable -Name $posVar -Scope script -Value $offset
            $text = [string](Get-Variable -Name $bufVar -Scope script -ValueOnly) + $text
            $parts = $text -split "`r?`n"
            if ($parts.Count -gt 1) {
                $lines = @($parts[0..($parts.Count - 2)])
                Set-Variable -Name $bufVar -Scope script -Value ([string]$parts[$parts.Count - 1])
            } else {
                Set-Variable -Name $bufVar -Scope script -Value $text
            }
        } finally { $fs.Dispose() }
    } catch { }
    return $lines
}

# Arquivos temporarios ficam em <DataDir>\logs\tmp (tudo em F:), nao em %TEMP%.
$tmpDir = [string]$cfg.tmpDir
if (-not $tmpDir) { $tmpDir = Split-Path ([string]$cfg.log) -Parent }
if (-not $tmpDir -or -not (Test-Path -LiteralPath $tmpDir)) {
    $tmpDir = Split-Path ([string]$cfg.log) -Parent
    $null = New-Item -ItemType Directory -Force -Path $tmpDir
}
$outFile = Join-Path $tmpDir ('dsh-sup-out-' + $PID + '.log')
$errFile = Join-Path $tmpDir ('dsh-sup-err-' + $PID + '.log')
Remove-Item -LiteralPath $outFile -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $errFile -Force -ErrorAction SilentlyContinue

# Start-Process -PassThru com -RedirectStandardOutput nao preenche ExitCode no
# PS 5.1. Abrimos um handle do processo ANTES da morte e lemos o exit code real
# com GetExitCodeProcess (sem admin).
if (-not ('W32Exit' -as [type])) {
    $w32 = @'
using System;
using System.Runtime.InteropServices;
public class W32Exit {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(int access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetExitCodeProcess(IntPtr h, out uint code);
    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr h);
}
'@
    Add-Type -TypeDefinition $w32 -Language CSharp -ErrorAction SilentlyContinue
}

$exe = [string]$cfg.exe
$argsArray = @()
if ($null -ne $cfg.args) { $argsArray = @($cfg.args) }
$workdir = [string]$cfg.workdir
if (-not $workdir) { $workdir = (Get-Location).Path }

# Monta a linha de argumentos com quoting explicito (Start-Process -ArgumentList
# nao adiciona aspas sozinho para argumentos com espaco).
function Quote-Arg([string]$a) {
    if ($null -eq $a) { return '""' }
    if ($a -match '[\s"]') {
        return '"' + ($a -replace '\\(?=")', '\\' -replace '"', '\"') + '"'
    }
    return $a
}
$argLine = (@($argsArray) | ForEach-Object { Quote-Arg ([string]$_) }) -join ' '

Add-Log ('=== SUPERVISOR INICIO ' + $started.ToString('yyyy-MM-dd HH:mm:ss.fff') + ' exe=' + $exe + ' ===')

$proc = $null
try {
    $proc = Start-Process -FilePath $exe -ArgumentList $argLine -WorkingDirectory $workdir -PassThru -RedirectStandardOutput $outFile -RedirectStandardError $errFile -WindowStyle Hidden
} catch {
    Add-Log ('=== FALHA AO INICIAR ' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff') + ' erro=' + $_.Exception.Message + ' ===')
    exit 3
}

$status = [pscustomobject]@{
    runner_pid = $PID
    target_pid = $proc.Id
    started    = $started.ToString('o')
    exe        = $exe
    workdir    = $workdir
    out_tmp    = $outFile
    err_tmp    = $errFile
}

# Handle aberto enquanto o processo ainda vive (permite ler o exit code real).
$hProc = [IntPtr]::Zero
try {
    if ('W32Exit' -as [type]) {
        $hProc = [W32Exit]::OpenProcess(0x1000, $false, $proc.Id)
        if ($hProc -eq [IntPtr]::Zero) { $hProc = [W32Exit]::OpenProcess(0x0400, $false, $proc.Id) }
    }
} catch { $hProc = [IntPtr]::Zero }
try {
    $json = $status | ConvertTo-Json -Depth 6
    [System.IO.File]::WriteAllText([string]$cfg.statusFile, $json, (New-Object System.Text.UTF8Encoding($false)))
} catch { }

$script:OutPos = 0
$script:ErrPos = 0
$script:OutBuf = ''
$script:ErrBuf = ''

while (-not $proc.HasExited) {
    $ts = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff')
    foreach ($ln in @(Read-NewLines $outFile 'out')) {
        if ($ln -ne '') { Add-Log ($ts + ' ' + $ln) }
    }
    foreach ($ln in @(Read-NewLines $errFile 'err')) {
        if ($ln -ne '') { Add-Log ($ts + ' [stderr] ' + $ln) }
    }
    Start-Sleep -Milliseconds 100
}

try { $proc.WaitForExit() } catch { }
$propCode = 'n/a'
try { $propCode = [string]$proc.ExitCode } catch { $propCode = 'erro' }
$exitCode = 0
$nativeOk = $false
$native = [uint32]0
if ($null -ne $hProc -and $hProc -ne [IntPtr]::Zero) {
    try {
        $nativeOk = [W32Exit]::GetExitCodeProcess($hProc, [ref]$native)
        [void][W32Exit]::CloseHandle($hProc)
    } catch { $nativeOk = $false }
}
if ($nativeOk -and [long]$native -ne 259) {
    # Converte uint32 para int32 com sinal (ex.: 4294967295 -> -1) sem estourar.
    $exitCode = [BitConverter]::ToInt32([BitConverter]::GetBytes([uint32]$native), 0)
} elseif ($propCode -match '^-?\d+$') {
    $exitCode = [int]$propCode
}
Add-Log ('=== EXITCODE prop=' + $propCode + ' nativo_ok=' + $nativeOk + ' nativo=' + [string]$native + ' ===')
$ended = Get-Date

# Ultimas linhas (flush).
$ts = $ended.ToString('yyyy-MM-dd HH:mm:ss.fff')
foreach ($ln in @(Read-NewLines $outFile 'out')) {
    if ($ln -ne '') { Add-Log ($ts + ' ' + $ln) }
}
foreach ($ln in @(Read-NewLines $errFile 'err')) {
    if ($ln -ne '') { Add-Log ($ts + ' [stderr] ' + $ln) }
}
if ($script:OutBuf -ne '') { Add-Log ($ts + ' ' + [string]$script:OutBuf) }
if ($script:ErrBuf -ne '') { Add-Log ($ts + ' [stderr] ' + [string]$script:ErrBuf) }

$duration = [math]::Round(($ended - $started).TotalSeconds, 1)
Add-Log ('=== DSH EXIT code=' + $exitCode + ' em ' + $ended.ToString('yyyy-MM-dd HH:mm:ss.fff') + ' duracao_s=' + $duration + ' ===')

$exitInfo = [pscustomobject]@{
    ts         = $ended.ToString('o')
    runner_pid = $PID
    dsh_pid    = $proc.Id
    exit_code  = $exitCode
    started    = $started.ToString('o')
    ended      = $ended.ToString('o')
    duration_s = $duration
    log        = $log
    out_tmp    = $outFile
    err_tmp    = $errFile
}
try {
    $json = $exitInfo | ConvertTo-Json -Depth 6
    [System.IO.File]::WriteAllText([string]$cfg.exitFile, $json, (New-Object System.Text.UTF8Encoding($false)))
} catch { }

try {
    Remove-Item -LiteralPath $outFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $errFile -Force -ErrorAction SilentlyContinue
} catch { }

exit $exitCode
