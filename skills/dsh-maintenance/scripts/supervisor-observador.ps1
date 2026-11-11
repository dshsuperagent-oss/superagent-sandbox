# supervisor-observador.ps1 - segundo processo leve que vigia o observador.
#
# O watchdog-3080.ps1 NAO cobre o observador. Este supervisor:
#   - le observacao\estado.json (heartbeat gravado a cada 5 s pelo observador);
#   - se o processo do observador sumiu OU o heartbeat parou, registra a lacuna
#     em observacao\lacunas-YYYY-MM-DD.jsonl (inicio/fim do buraco) e reergue
#     o observador;
#   - nunca toca no DSH nem na porta 3080.
#
# Instalado no Startup do usuario junto com o observador.

[CmdletBinding()]
param(
    [string]$DataDir = 'F:\ai\_lab\dsh-saude\observador',
    [int]$IntervalSec = 30,
    [int]$HeartbeatMaxSec = 45,
    [int]$StartWaitSec = 30,
    [switch]$NoStart
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'lib.ps1')

$ObsDir = Join-Path $DataDir 'observacao'
$LogDir = Join-Path $DataDir 'logs'
foreach ($d in @($DataDir, $ObsDir, $LogDir)) {
    if (-not (Test-Path -LiteralPath $d)) { $null = New-Item -ItemType Directory -Force -Path $d }
}

$mutexName = Get-SupervisorMutexName $DataDir
$mutex = New-InstanceMutex $mutexName
if ($null -eq $mutex) { $mutex = New-InstanceMutex ('Local\' + $mutexName) }
if ($null -eq $mutex) {
    Write-PlainLog $LogDir 'supervisor-observador' ('outra instancia ja roda para ' + $DataDir + '; saindo')
    exit 0
}

$estadoPath = Join-Path $ObsDir 'estado.json'
$observerScript = Join-Path $PSScriptRoot 'observador.ps1'

function Get-Estado {
    return (Read-JsonFile $estadoPath)
}

function Get-HeartbeatAge {
    param($Estado)
    if ($null -eq $Estado -or -not $Estado.ultimo_ciclo) { return 999999.0 }
    try {
        return ((Get-Date) - [datetime]::Parse([string]$Estado.ultimo_ciclo)).TotalSeconds
    } catch { return 999999.0 }
}

function Test-ObserverRunning {
    param($Estado)
    if ($null -eq $Estado -or -not $Estado.pid) { return $false }
    $procId = [int]$Estado.pid
    $map = Get-ProcessNameMap
    if (-not $map.ContainsKey($procId)) { return $false }
    $detail = Get-PebInfo $procId
    if (-not $detail.ok -or -not $detail.cmdline) { return $false }
    if ($detail.cmdline -like "*$observerScript*") { return $true }
    return $false
}

function Write-Lacuna($Record, [datetime]$Day) {
    $null = Add-JsonlRecord $ObsDir 'lacunas' $Record $Day
}

function Start-Observer {
    try {
        $p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $observerScript, '-DataDir', $DataDir) -WindowStyle Hidden -PassThru
        return $p
    } catch {
        Write-PlainLog $LogDir 'supervisor-observador' ('falha ao iniciar observador: ' + $_.Exception.Message)
        return $null
    }
}

function Wait-FreshHeartbeat([int]$Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 2
        $e = Get-Estado
        $age = Get-HeartbeatAge $e
        if ($age -lt 15) { return $e }
    }
    return (Get-Estado)
}

Write-PlainLog $LogDir 'supervisor-observador' ('iniciado pid=' + $PID + ' data_dir=' + $DataDir + ' intervalo=' + $IntervalSec + 's')

$primeiroCiclo = $true
try {
    while ($true) {
        $estado = Get-Estado
        $age = Get-HeartbeatAge $estado
        $running = Test-ObserverRunning $estado
        $agora = Get-Date

        # Janela de graca: no primeiro ciclo o observador pode estar subindo.
        if ($null -eq $estado -and $primeiroCiclo) {
            Start-Sleep -Seconds 10
            $estado = Get-Estado
            $age = Get-HeartbeatAge $estado
            $running = Test-ObserverRunning $estado
        }
        $primeiroCiclo = $false

        if ((-not $running) -or ($age -gt $HeartbeatMaxSec)) {
            $tipo = 'observador_morto'
            if ($running) { $tipo = 'heartbeat_parado' }

            $ultimo = $null
            if ($null -ne $estado -and $estado.ultimo_ciclo) { $ultimo = [string]$estado.ultimo_ciclo }
            $lacunaInicio = $null
            if ($null -ne $ultimo) {
                try { $lacunaInicio = [datetime]::Parse($ultimo) } catch { $lacunaInicio = $null }
            }
            $lacunaSec = $null
            if ($null -ne $lacunaInicio) { $lacunaSec = [math]::Round(($agora - $lacunaInicio).TotalSeconds, 0) }

            Write-PlainLog $LogDir 'supervisor-observador' ('ALERTA ' + $tipo + ' (heartbeat ' + [math]::Round($age, 0) + 's)')

            $acao = 'nenhuma'
            $novoPid = 0
            $novoInicio = $null

            if ($running) {
                $oldPid = [int]$estado.pid
                $info = Get-PebInfo $oldPid
                if ($info.ok -and $info.cmdline -and $info.cmdline -like "*$observerScript*") {
                    try {
                        Stop-Process -Id $oldPid -Force -ErrorAction Stop
                        $acao = 'observador_travado_encerrado_e_reiniciado'
                    } catch {
                        $acao = 'falha_ao_encerrar_observador_travado'
                    }
                }
            }

            if (-not $NoStart) {
                $p = Start-Observer
                if ($null -ne $p) {
                    $novoPid = $p.Id
                    $novoInicio = $agora.ToString('o')
                    $fresh = Wait-FreshHeartbeat $StartWaitSec
                    if ((Get-HeartbeatAge $fresh) -lt 15) {
                        if ($acao -eq 'nenhuma') { $acao = 'reiniciado' }
                        try { $novoPid = [int]$fresh.pid } catch { }
                    } else {
                        if ($acao -eq 'nenhuma') { $acao = 'reinicio_falhou' }
                        Write-PlainLog $LogDir 'supervisor-observador' 'observador nao confirmou heartbeat na janela de espera'
                    }
                }
            }

            $rec = [pscustomobject]@{
                ts                 = $agora.ToString('o')
                tipo               = $tipo
                ultimo_heartbeat   = $ultimo
                lacuna_s           = $lacunaSec
                acao               = $acao
                novo_pid           = $novoPid
                heartbeat_max_s    = $HeartbeatMaxSec
            }
            Write-Lacuna $rec $agora.Date
            Write-PlainLog $LogDir 'supervisor-observador' ('lacuna registrada: ' + $tipo + ' acao=' + $acao + ' novo_pid=' + $novoPid)
        }

        Start-Sleep -Seconds $IntervalSec
    }
} finally {
    try { $mutex.ReleaseMutex() } catch { }
    try { $mutex.Dispose() } catch { }
}
