# test-captura-taskkill-real.ps1 - PROVA DE ACEITE da issue #33: o observador
# captura o taskkill REAL (processo externo, vida ~120-170 ms) e classifica killed.
#
# RODAR (shell normal, fora do job restrito do agente):
#   powershell -NoProfile -ExecutionPolicy Bypass -File <repo>\skills\dsh-maintenance\tests\test-captura-taskkill-real.ps1
#
# 3 execucoes independentes. Em cada uma:
#   1. cria um alvo descartavel (powershell -NoProfile -Command "Start-Sleep 300");
#   2. sobe o observador com DataDir proprio, -TargetPid <alvo> e -DurationSeconds 150;
#   3. espera o heartbeat (estado.json fresco) e ~1 s;
#   4. executa taskkill.exe /PID <alvo> /F (capturando a saida) e mede o instante;
#   5. espera o veredito (Wait-Until, -VerdictTimeoutSec) e exige:
#        veredito=killed, assassino.nome com 'taskkill', assassino.ppid > 0,
#        assassino.cmdline com '/PID <alvo>' (o PID do alvo sozinho e aceito como
#        fallback, com AVISO) e alvo.pid = PID do alvo;
#   6. mostra o registro do taskkill em processos-*.jsonl (event=start, name,
#      cmdline) e o registro de exit (lifetime_ms), quando houver.
#
# PASS somente com 3/3 (exit 0). Falha real -> exit 1 com o resumo das falhas.
# Se o taskkill for bloqueado pelo shell ("Acesso negado"), imprime SKIP e sai
# com exit 3: o teste nao prova nada nesse shell.
#
# SEGURANCA: nao toca no DSH. O alvo e um powershell descartavel e o observador
# usa DataDir proprio. No finally so encerra os PIDs criados por ESTE teste
# (observador e alvo). Nada de taskkill/Stop-Process por nome.
#
# Exit codes: 0 = PASS (3/3); 1 = FAIL; 2 = pre-requisito ausente;
#             3 = SKIP (taskkill bloqueado neste shell - rodar em shell normal/Explorer).

[CmdletBinding()]
param(
    [string]$RepoRoot = '',
    [int]$TimeoutSec = 60,
    [int]$VerdictTimeoutSec = 15
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot '_lib-test.ps1')

$TotalRuns = 3

if (-not $RepoRoot) { $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path }
if (-not (Test-Path -LiteralPath $RepoRoot)) {
    Write-Host ('FAIL: RepoRoot inexistente: ' + $RepoRoot)
    exit 2
}
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path

$skillRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$script:Observer = Join-Path $skillRoot 'scripts\observador.ps1'
$script:RepoRoot = $RepoRoot

function Truncate-TestText([string]$s, [int]$n) {
    if (-not $s) { return '' }
    if ($s.Length -le $n) { return $s }
    return $s.Substring(0, $n) + '...'
}

function Get-TaskkillRecord {
    # Registros de taskkill.exe na processos-*.jsonl do dia, ligados ao alvo.
    param(
        [string]$ProcFile,
        [int]$VictimPid,
        [string]$Event
    )
    $linhas = @(Get-Content -LiteralPath $ProcFile -ErrorAction SilentlyContinue)
    $rxPid = ('(?<!\d)' + [string]$VictimPid + '(?!\d)')
    $saida = New-Object System.Collections.ArrayList
    foreach ($l in $linhas) {
        if ($l -notmatch '"name":"taskkill') { continue }
        if ($l -notmatch ('"event":"' + $Event + '"')) { continue }
        if ($l -notmatch $rxPid) { continue }
        $null = $saida.Add($l)
    }
    return $saida.ToArray()
}

function Invoke-TaskkillRun {
    param([int]$Index)

    $dataDir = New-TestDataDir $script:RepoRoot ('taskkill-real-run' + $Index)
    $obsDir = Join-Path $dataDir 'observacao'
    $estado = Join-Path $obsDir 'estado.json'
    $obsPid = 0
    $victimPid = 0
    $victim = $null
    $falhas = New-Object System.Collections.ArrayList

    $nome = ''
    $ppid = 0
    $cmd = ''
    $tkPid = 0
    $vereditoTxt = '(sem veredito)'
    $deathToVerdict = $null
    $tkLifetime = ''

    try {
        $victim = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep 300') -PassThru -WindowStyle Hidden
        $victimPid = [int]$victim.Id
        Write-TestStamp ('   alvo descartavel pid=' + $victimPid)

        $argLine = '-NoProfile -ExecutionPolicy Bypass -File "' + $script:Observer + '" -DataDir "' + $dataDir + '" -TargetPid ' + $victimPid + ' -DurationSeconds 150'
        $obs = Start-Process -FilePath 'powershell.exe' -ArgumentList $argLine -WindowStyle Hidden -PassThru
        $obsPid = [int]$obs.Id
        Write-TestStamp ('   observador pid=' + $obsPid + ' (DataDir proprio, so leitura)')

        if (-not (Wait-Heartbeat $estado $TimeoutSec)) {
            $null = $falhas.Add('observador nao gravou heartbeat em ' + $TimeoutSec + ' s')
            return [pscustomobject]@{ Ok = $false; Skip = $false; Motivo = ''; Falhas = $falhas.ToArray() }
        }
        Write-TestStamp '   heartbeat fresco; alvo fixado'
        Start-Sleep -Milliseconds 1000

        if ($victim.HasExited) {
            $null = $falhas.Add('alvo descartavel morreu antes do taskkill')
            return [pscustomobject]@{ Ok = $false; Skip = $false; Motivo = ''; Falhas = $falhas.ToArray() }
        }

        $killAt = Get-Date
        Write-TestStamp ('   assassinato: taskkill.exe /PID ' + $victimPid + ' /F')
        $tkOut = @(& taskkill.exe /PID $victimPid /F 2>&1 | ForEach-Object { [string]$_ })
        $tkExit = [int]$LASTEXITCODE
        foreach ($l in $tkOut) { if ($l) { Write-Host ('     taskkill: ' + $l) } }
        # O taskkill bem-sucedido mata em ms; espera curta para nao confundir com
        # "acesso negado" por atraso de TerminateProcess.
        $alvoMorto = [bool](Wait-Until { $victim.HasExited } 5 100)

        if (-not $alvoMorto) {
            $tkTexto = ($tkOut -join ' ')
            $negado = [bool]($tkTexto -match '(?i)(acesso negado|access is denied|\bdenied\b|\bnegad)')
            if ($negado -or $tkExit -ne 0) {
                $procFileSkip = Join-Path $obsDir ('processos-' + (Get-Date).ToString('yyyy-MM-dd') + '.jsonl')
                $tkSkip = @()
                if (Test-Path -LiteralPath $procFileSkip) { $tkSkip = @(Get-TaskkillRecord $procFileSkip $victimPid 'start') }
                Write-TestStamp ('   taskkill NAO matou (exit=' + $tkExit + '); registros de taskkill capturados nesta execucao: ' + $tkSkip.Count)
                $motivo = 'taskkill bloqueado neste shell (exit=' + $tkExit + '): ' + (Truncate-TestText $tkTexto 200)
                return [pscustomobject]@{ Ok = $false; Skip = $true; Motivo = $motivo; Falhas = $falhas.ToArray() }
            }
            $null = $falhas.Add('alvo nao morreu e o taskkill nao reportou acesso negado')
            return [pscustomobject]@{ Ok = $false; Skip = $false; Motivo = ''; Falhas = $falhas.ToArray() }
        }
        Write-TestStamp ('   alvo morto pelo taskkill; medida do kill em ' + $killAt.ToString('HH:mm:ss.fff'))

        $verdict = Wait-Until { Get-NewestVerdict $obsDir } $VerdictTimeoutSec 300
        if ($null -eq $verdict) {
            $null = $falhas.Add('nenhum veredito em ' + $VerdictTimeoutSec + ' s (morte->veredito estourou)')
            return [pscustomobject]@{ Ok = $false; Skip = $false; Motivo = ''; Falhas = $falhas.ToArray() }
        }
        $vereditoTxt = [string]$verdict.veredito

        if ($verdict.gerado_em) {
            try { $deathToVerdict = [math]::Round(([datetime]::Parse([string]$verdict.gerado_em) - $killAt).TotalSeconds, 2) } catch { }
        }
        if ($null -eq $deathToVerdict) {
            $vf = Get-ChildItem -LiteralPath $obsDir -Filter 'veredito-*.json' -File -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending | Select-Object -First 1
            if ($vf) { $deathToVerdict = [math]::Round(($vf.LastWriteTime - $killAt).TotalSeconds, 2) }
        }

        $procFile = Join-Path $obsDir ('processos-' + (Get-Date).ToString('yyyy-MM-dd') + '.jsonl')
        $tkStart = @()
        $tkExitRec = @()
        if (Test-Path -LiteralPath $procFile) {
            $tkStart = @(Get-TaskkillRecord $procFile $victimPid 'start')
            $tkExitRec = @(Get-TaskkillRecord $procFile $victimPid 'exit')
        }

        $assassino = $verdict.assassino
        if ($null -ne $assassino) {
            $nome = [string]$assassino.nome
            $cmd = [string]$assassino.cmdline
            try { $ppid = [int]$assassino.ppid } catch { $ppid = 0 }
            try { $tkPid = [int]$assassino.pid } catch { $tkPid = 0 }
        } elseif ($tkStart.Count -gt 0) {
            try { $tkPid = [int](($tkStart[0] | ConvertFrom-Json).pid) } catch { }
        }
        if ($tkExitRec.Count -gt 0) {
            try { $tkLifetime = [string](($tkExitRec[0] | ConvertFrom-Json).lifetime_ms) } catch { }
        }

        Write-Host ''
        Write-Host ('   == registro do taskkill em ' + [System.IO.Path]::GetFileName($procFile) + ' ==')
        if ($tkStart.Count -gt 0) {
            Write-Host (Truncate-TestText $tkStart[0] 700)
        } else {
            Write-Host '   (nenhum event=start de taskkill ligado ao alvo)'
        }
        if ($tkExitRec.Count -gt 0) { Write-Host ('   exit: ' + (Truncate-TestText $tkExitRec[0] 400)) }

        # --- verificacoes do aceite ---
        if ($verdict.veredito -ne 'killed') { $null = $falhas.Add('veredito=' + [string]$verdict.veredito + ' (esperado killed)') }
        if ($null -eq $verdict.alvo -or [int]$verdict.alvo.pid -ne $victimPid) {
            $null = $falhas.Add('veredito.alvo.pid diferente do alvo (' + [string]$victimPid + ')')
        }
        if ($null -eq $assassino) {
            $null = $falhas.Add('veredito sem campo assassino')
        } else {
            if ($nome -notmatch '(?i)taskkill') { $null = $falhas.Add('assassino.nome=' + $nome + ' (esperado taskkill)') }
            if ($ppid -le 0) { $null = $falhas.Add('assassino.ppid ausente (0)') }
            $pidArg = [bool]($cmd -match ('(?i)/PID\s+' + [string]$victimPid + '(?!\d)'))
            $pidSo = [bool]($cmd -match ('(?<!\d)' + [string]$victimPid + '(?!\d)'))
            if (-not $pidArg) {
                if ($pidSo) {
                    Write-Host '   AVISO: assassino.cmdline cita o PID do alvo sem o formato "/PID <alvo>" (aceito como fallback)'
                } else {
                    $null = $falhas.Add('assassino.cmdline nao cita "/PID <alvo>" nem o PID do alvo')
                }
            }
        }
        if ($tkStart.Count -lt 1) { $null = $falhas.Add('sem registro event=start de taskkill.exe na processos-*.jsonl') }

        Write-TestStamp ('   taskkill pid=' + $tkPid + ' ppid=' + $ppid + ' nome=' + $nome)
        Write-TestStamp ('   cmdline=' + (Truncate-TestText $cmd 220))
        Write-TestStamp ('   veredito=' + $vereditoTxt + ' morte->veredito_s=' + $deathToVerdict + ' lifetime_ms=' + $tkLifetime)

        return [pscustomobject]@{ Ok = ($falhas.Count -eq 0); Skip = $false; Motivo = ''; Falhas = $falhas.ToArray() }
    } finally {
        # So os PIDs criados por este teste; nunca o PID do shell atual.
        if ($obsPid -gt 0 -and $obsPid -ne $PID) {
            try { Stop-Process -Id $obsPid -Force -ErrorAction SilentlyContinue } catch { }
        }
        if ($victimPid -gt 0 -and $victimPid -ne $PID) {
            try { Stop-Process -Id $victimPid -Force -ErrorAction SilentlyContinue } catch { }
        }
    }
}

# ---------------------------------------------------------------------------
# Inicio
# ---------------------------------------------------------------------------

Write-Host ('== test-captura-taskkill-real (PowerShell ' + $PSVersionTable.PSVersion + ') ==')
Write-TestStamp ('repo=' + $RepoRoot)
Write-TestStamp ('observador=' + $script:Observer)

if (-not (Test-Path -LiteralPath $script:Observer)) {
    Write-Host ('FAIL: observador ausente: ' + $script:Observer)
    exit 2
}
$taskkillExe = Join-Path $env:SystemRoot 'System32\taskkill.exe'
if (-not (Test-Path -LiteralPath $taskkillExe)) {
    Write-Host ('FAIL: taskkill.exe ausente: ' + $taskkillExe)
    exit 2
}

$okRuns = 0
$todasFalhas = New-Object System.Collections.ArrayList

for ($i = 1; $i -le $TotalRuns; $i++) {
    Write-Host ''
    Write-TestStamp ('== execucao ' + $i + '/' + $TotalRuns + ' ==')
    $r = Invoke-TaskkillRun $i
    if ($r.Skip) {
        Write-Host ''
        Write-Host 'RESULTADO: SKIP (taskkill bloqueado neste shell - rodar em shell normal/Explorer)'
        Write-Host ('motivo: ' + $r.Motivo)
        Write-Host 'Neste shell o teste NAO prova nada do aceite: rode o mesmo comando em um'
        Write-Host 'shell normal (Explorer -> powershell), onde taskkill.exe pode encerrar o alvo.'
        exit 3
    }
    if ($r.Ok) {
        $okRuns++
        Write-TestStamp ('   execucao ' + $i + ': PASS')
    } else {
        foreach ($f in @($r.Falhas)) { $null = $todasFalhas.Add(('run ' + $i + ': ' + $f)) }
        Write-TestStamp ('   execucao ' + $i + ': FAIL')
    }
}

Write-Host ''
Write-TestStamp ('execucoes PASS: ' + $okRuns + '/' + $TotalRuns)
if ($okRuns -eq $TotalRuns) {
    Write-Host ('RESULTADO: PASS - taskkill real capturado ' + $okRuns + '/' + $TotalRuns + ': veredito killed, assassino taskkill, ppid>0 e cmdline com /PID <alvo>.')
    exit 0
}
Write-Host ('RESULTADO: FAIL - ' + ($todasFalhas -join '; '))
exit 1
