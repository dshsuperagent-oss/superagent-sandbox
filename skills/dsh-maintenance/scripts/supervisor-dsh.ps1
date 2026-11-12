# supervisor-dsh.ps1 - inicia o DSH diario sob supervisao e registra ExitCode + instante.
#
# Em vez de o DSH nascer solto do cmd, o supervisor:
#   - inicia um runner (PowerShell oculto) com Start-Process -PassThru;
#   - o runner inicia o DSH com Start-Process -PassThru e guarda o handle;
#   - stdout+stderr sao gravados com timestamp em logs\dsh-console-timestamped.log;
#   - na morte, registra ExitCode e o instante exato em logs\supervisor-YYYY-MM-DD.jsonl
#     e em logs\supervisor-exit-<stamp>.json.
#
# NAO reinicia sozinho por padrao (o vigia watchdog-3080.ps1 sobe servidor morto).
# Com -Restart, reinicia SOMENTE depois de gravar o registro de saida.
# NUNCA mata o DSH nem qualquer processo.

[CmdletBinding()]
param(
    [string]$DataDir = 'F:\ai\_lab\dsh-saude\observador',
    [string]$Exe = 'node',
    [Alias('Args')]
    [string[]]$TargetArgs = @('--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web'),
    [string]$WorkDir = 'F:\deepseek harness',
    [string]$ConfigPath = '',
    [int]$RestartDelaySec = 10,
    [switch]$OnlyIfDown,
    [switch]$Restart
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'lib.ps1')

# -OnlyIfDown: se a porta 3080 ja responde, nao inicia nada (uso seguro no logon,
# em paralelo com o boot script existente).
if ($OnlyIfDown) {
    $probe = Invoke-HttpProbe 3080
    if ($probe.code -eq '200' -or $probe.code -eq '401') {
        Write-Host ('DSH ja no ar (HTTP ' + $probe.code + '); supervisor nao inicia nada.')
        exit 0
    }
}

# Config JSON opcional: { exe, args[], workdir }. Util para testes e para nao
# depender de quoting de arrays na linha de comando.
if ($ConfigPath) {
    $cfgFile = Read-JsonFile $ConfigPath
    if ($null -eq $cfgFile) {
        Write-Host ('ERRO: config invalida: ' + $ConfigPath)
        exit 2
    }
    $Exe = [string]$cfgFile.exe
    $TargetArgs = @($cfgFile.args)
    if ($cfgFile.workdir) { $WorkDir = [string]$cfgFile.workdir }
}

$LogDir = Join-Path $DataDir 'logs'
$tmpDir = Join-Path $LogDir 'tmp'
foreach ($d in @($LogDir, $tmpDir)) {
    if (-not (Test-Path -LiteralPath $d)) { $null = New-Item -ItemType Directory -Force -Path $d }
}

$mutexName = 'Global\DSH-SupervisorDsh-' + (Get-StableHash $DataDir)
$mutex = New-InstanceMutex $mutexName
if ($null -eq $mutex) { $mutex = New-InstanceMutex ('Local\' + $mutexName) }
if ($null -eq $mutex) {
    Write-PlainLog $LogDir 'supervisor-dsh' 'ja existe um supervisor-dsh para este DataDir; saindo'
    exit 0
}

$runner = Join-Path $PSScriptRoot 'supervisor-runner.ps1'
if (-not (Test-Path -LiteralPath $runner)) {
    Write-PlainLog $LogDir 'supervisor-dsh' ('runner ausente: ' + $runner)
    exit 2
}

$consoleLog = Join-Path $LogDir 'dsh-console-timestamped.log'

function Start-Run {
    $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
    $cfgPath = Join-Path $LogDir ('supervisor-run-' + $stamp + '.json')
    $statusFile = Join-Path $LogDir ('supervisor-status-' + $stamp + '.json')
    $exitFile = Join-Path $LogDir ('supervisor-exit-' + $stamp + '.json')

    $cfg = [pscustomobject]@{
        exe        = $Exe
        args       = @($TargetArgs)
        workdir    = $WorkDir
        log        = $consoleLog
        exitFile   = $exitFile
        statusFile = $statusFile
        tmpDir     = $tmpDir
    }
    Write-JsonFile $cfgPath $cfg

    Write-PlainLog $LogDir 'supervisor-dsh' ('iniciando DSH: ' + $Exe + ' ' + (@($TargetArgs) -join ' '))

    $runnerProc = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $runner, '-ConfigPath', $cfgPath) -WindowStyle Hidden -PassThru
    $runnerProc.WaitForExit()
    $ended = Get-Date
    $runnerExit = -999
    try { $runnerExit = [int]$runnerProc.ExitCode } catch { }

    $dshPid = 0
    $status = Read-JsonFile $statusFile
    if ($null -ne $status) { try { $dshPid = [int]$status.target_pid } catch { } }

    $exitInfo = Read-JsonFile $exitFile
    $exitCode = $runnerExit
    $startedIso = $null
    if ($null -ne $exitInfo) {
        try { $exitCode = [int]$exitInfo.exit_code } catch { }
        $startedIso = [string]$exitInfo.started
    }

    $record = [pscustomobject]@{
        ts          = $ended.ToString('o')
        event       = 'dsh_exit'
        runner_pid  = $runnerProc.Id
        dsh_pid     = $dshPid
        exit_code   = $exitCode
        runner_exit = $runnerExit
        started     = $startedIso
        ended       = $ended.ToString('o')
        log         = $consoleLog
        exit_file   = $exitFile
        workdir     = $WorkDir
        exe         = $Exe
    }
    $day = (Get-Date).Date
    $null = Add-JsonlRecord $LogDir 'supervisor' $record $day
    Write-JsonFile $exitFile $record
    Write-PlainLog $LogDir 'supervisor-dsh' ('DSH saiu: exit_code=' + $exitCode + ' dsh_pid=' + $dshPid + ' em ' + $ended.ToString('yyyy-MM-dd HH:mm:ss.fff'))
    return $exitCode
}

# Espera o observador gravar um veredito para a morte (ate 15 s). Sem veredito,
# NAO reinicia: a regra e nao reiniciar sem antes gravar o veredito.
function Wait-VerdictAfter([datetime]$Since, [int]$Seconds = 15) {
    $obsDir = Join-Path $DataDir 'observacao'
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        $v = Get-ChildItem -LiteralPath $obsDir -Filter 'veredito-*.json' -File -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($v -and $v.LastWriteTime -ge $Since) { return $v.FullName }
        Start-Sleep -Milliseconds 500
    }
    return $null
}

try {
    while ($true) {
        $deathAt = Get-Date
        $code = Start-Run
        if (-not $Restart) { break }
        $verdict = Wait-VerdictAfter $deathAt 15
        if (-not $verdict) {
            Write-PlainLog $LogDir 'supervisor-dsh' ('sem veredito do observador em 15s; NAO reinicio (regra da issue).')
            break
        }
        Write-PlainLog $LogDir 'supervisor-dsh' ('veredito gravado: ' + $verdict + '; -Restart ativo: nova tentativa em ' + $RestartDelaySec + 's')
        Start-Sleep -Seconds $RestartDelaySec
    }
} finally {
    try { $mutex.ReleaseMutex() } catch { }
    try { $mutex.Dispose() } catch { }
}
