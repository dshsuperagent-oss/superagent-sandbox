# TESTES — dsh-maintenance / dsh-observador (2026-11-11)

Evidência dos testes obrigatórios da issue #30. Todos rodam **sem tocar no DSH**:
os processos descartáveis são `powershell.exe -c "Start-Sleep 300"` e o
observador é apontado para eles com `-TargetPid`. A porta 3080 foi monitorada
(HTTP 401 em ~1–2 ms) durante todos os testes e o processo do DSH
(`node`, PID 29072) **não foi encerrado nem reiniciado**.

Ambiente: Windows 11 build 22621, PowerShell 5.1.22621.4249, sem admin,
24 processadores lógicos. Testes em `skills\dsh-maintenance\tests\`.

> **Limite do ambiente do agente:** o shell do agente roda em um job restrito que
> **bloqueia `taskkill`** (`ERRO: Acesso negado` mesmo em processo descartável
> filho). Por isso o teste de captura foi executado com um assassino externo
> equivalente (`powershell -Command "Stop-Process -Id <pid> -Force"`) e o modo
> `-Killer taskkill` foi executado para provar a captura do `taskkill.exe`
> (bloqueado). O teste com `taskkill` real deve ser rodado pelo Lead em um shell
> normal — o script é o mesmo.

## 1. Captura de assassino (sintética) — PASS

Comando:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\skills\dsh-maintenance\tests\test-captura-killer.ps1
```

Resultado: `RESULTADO: PASS - observador capturou PID/PPID/CommandLine e classificou killed.`

Trecho real de `observacao\processos-2026-11-11.jsonl` (linha 40; encurtado) e do
veredito (evidência na linha 40):

```json
{"ts":"2026-11-11T19:55:09.464-03:00","event":"start","pid":5104,"ppid":20312,"name":"powershell","cmdline":"\"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -NoProfile -Command Stop-Process -Id 27020 -Force ","start":"2026-11-11T19:55:09.3240282-03:00","ancestors":[{"pid":20312,"ppid":16532,"name":"powershell","cmdline":"...test-captura-killer.ps1"},{"pid":16532,"ppid":29096,"name":"powershell","cmdline":"..."}],"suspect":true,"reasons":["nome:powershell","cmdline_suspeita","menciona_pid_alvo"],"target_pid":27020,"fonte":"peb","error":null}
```

```json
{"veredito":"killed","confianca":"media","causa":"processo_alvo_desapareceu","alvo":{"pid":27020,"nome":"powershell","start":"..."},
 "resumo":"Encerrado por powershell (pid 5104, pai 20312): ... Stop-Process -Id 27020 -Force",
 "assassino":{"pid":5104,"ppid":20312,"nome":"powershell","cmdline":"... Stop-Process -Id 27020 -Force ","ancestrais":[{"pid":20312,"ppid":16532,"name":"powershell"},{"pid":16532,"ppid":29096,"name":"powershell"}],"fonte":"processos-2026-11-11.jsonl","linha":40},
 "evidencias":[{"fonte":"processos-2026-11-11.jsonl","linha":40,...},{"fonte":"snapshot-2026-11-11.jsonl","linha":1,...},{"fonte":"processos-2026-11-11.jsonl","linha":34,...},{"fonte":"processos-2026-11-11.jsonl","linha":44,...}]}
```

Confiança `media` é o correto para `Stop-Process` (o `alta` exige `taskkill`/PID
literal na linha de comando; ver README). PID, PPID, CommandLine e a cadeia de
ancestrais estão todos presentes.

### 1b. `taskkill` real — SKIP honesto neste shell

Comando:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\skills\dsh-maintenance\tests\test-captura-killer.ps1 -Killer taskkill
```

Saída:

```
taskkill: ERRO: Acesso negado
taskkill BLOQUEADO neste shell (Acesso negado): comprovando apenas a CAPTURA do taskkill.exe
RESULTADO: SKIP - taskkill bloqueado neste shell e curto demais para o poll de 100 ms.
```

O bloqueio é do **job restrito do agente** (proteção do próprio DSH), não do
observador. Em um shell normal o `taskkill` bem-sucedido fica visível ~140 ms
(medido) e é capturado pelo poll de 100 ms; o Lead deve rodar este modo após o
`install.ps1` para a prova final.

### 1c. Janela de visibilidade do `taskkill` (medição que sustenta o poll de 100 ms)

Método: processo descartável + `taskkill /PID <pid> /F`; amostragem em loop com
`[Diagnostics.Process]::GetProcesses()` a cada ~1 ms, 8 tentativas, mesma máquina.
Cada tentativa mostra em que milissegundo o `taskkill` apareceu/desapareceu:

| Tentativa | 1ª vez visível (ms) | última vez visível (ms) | janela (ms) |
|---|---|---|---|
| 1 | 56 | 189 | 133 |
| 2 | 12 | 144 | 132 |
| 3 | 12 | 177 | 165 |
| 4 | 12 | 139 | 127 |
| 5 | 12 | 130 | 118 |
| 6 | 12 | 130 | 118 |
| 7 | 12 | 137 | 125 |
| 8 | 12 | 129 | 117 |

Conclusão: um `taskkill` que **consegue** matar vive ~117–165 ms; um poll de
100 ms tem margem confortável. Um `taskkill` que falha (acesso negado) sai em
< 50 ms — por isso o modo `-Killer taskkill` neste sandbox retorna SKIP em vez de
provar a captura.

## 2. Supervisor (ExitCode + instante) — PASS

Comando:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\skills\dsh-maintenance\tests\test-supervisor.ps1
```

Trecho real de `logs\dsh-console-timestamped.log`:

```
=== SUPERVISOR INICIO 2026-11-11 19:23:41.828 exe=powershell.exe ===
=== DSH EXIT code=-1 em 2026-11-11 19:23:44.417 duracao_s=2.6 ===
```

Trecho real de `logs\supervisor-2026-11-11.jsonl`:

```json
{"ts":"2026-11-11T19:23:44.4443284-03:00","event":"dsh_exit","runner_pid":27076,"dsh_pid":27728,"exit_code":-1,"runner_exit":-1,"started":"2026-11-11T19:23:41.8289579-03:00","ended":"2026-11-11T19:23:44.4443284-03:00","log":"...\dsh-console-timestamped.log","exit_file":"...\supervisor-exit-20261111-192341.json"}
```

`exit_code=-1` (`0xFFFFFFFF`) é a assinatura de processo morto por
`TerminateProcess`/`taskkill /F`; o instante tem milissegundos. Resultado:
`RESULTADO: PASS`.

## 3. Rotação / retenção — PASS

Comando:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\skills\dsh-maintenance\tests\test-rotacao.ps1
```

Saída:

```
1. simulando 2026-11-01 (retencao 1 dia) -> arquivos do dia 01: 4
2. simulando 2026-11-11 (retencao 1 dia) -> deve apagar 2026-11-01

observacao\ apos os dois dias:
snapshot-2026-11-11.jsonl
processos-2026-11-11.jsonl
eventos-2026-11-11.jsonl
hash-sessoes-2026-11-11.jsonl
estado.json

log: 2026-11-11 19:23:53.783 retencao removeu 4 arquivo(s) de observacao
RESULTADO: PASS - rotacao por dia e retencao funcionando.
```

## 4. Instalador idempotente — PASS

Comando:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\skills\dsh-maintenance\tests\test-install.ps1
```

Resultado:

```
run 1: startup = 2 arquivos; observador pids: 8708 | supervisor pids: 24768; EXIT=0
run 2: instancias anteriores encerradas: 8708, 24768; observador pids: 2008 | supervisor pids: 3496; EXIT=0
contagem final: observador=1 supervisor=1
Startup: DSH - observador 3080.cmd + DSH - supervisor observador 3080.cmd (2 arquivos, sem duplicata)
uninstall: processos encerrados 2008, 3496; Startup removida; observacao\ e logs\ mantidos
RESULTADO: PASS - install 2x sem duplicar Startup/processos; uninstall removeu Startup e manteve dados.
```

O `install.ps1` também imprime as 3 primeiras linhas de `snapshot`,
`processos`, `eventos`, `hash-sessoes` e `estado.json` como prova de que os
arquivos estão gravando.

Validação extra do modo opcional `-SuperviseDsh` (sem iniciar nada, `-NoStart`):
cria a terceira entrada `DSH - supervisor-dsh 3080.cmd` com `-OnlyIfDown`
(nunca duplica/mata um DSH no ar) e o `uninstall.ps1` remove as 3 entradas,
mantendo `observacao\` e `logs\`.

## 5. Custo (10 min) — PASS

Método: observador rodando com os defaults, monitorando a 3080 real; 30 amostras
de CPU/RAM a cada 20 s (600 s), 24 processadores lógicos, Windows 11.

| Métrica | Resultado |
|---|---|
| CPU acumulada | 28,58 s em 600 s = **4,76 % de 1 núcleo** |
| CPU média da máquina | **0,198 %** (28,58 / (600 × 24)) |
| Working set (RSS) | média **39,4 MB**, máxima **47,0 MB** |
| Commit privado | média **74,7 MB**, máxima **78,7 MB** |
| Volume observado | 298 snapshots + 185 processos + 22 sessões em 10 min |
| Projeção de disco | **~45 MB/dia** (snapshot 13,6 MB/dia + processos ~26 MB + resto) |
| HTTP do DSH | 401 em ~1–4 ms; probe (com spawn do curl) 12,7 ms médio / 45 ms máx |

O working set é mantido baixo por `GC.Collect()` + `EmptyWorkingSet` no próprio
processo 1×/min (`-TrimSec 60`); sem o trim, o working set fica ~90 MB (commit
privado não muda). Nenhum ajuste toca no DSH.

Amostras (t em s, CPU acumulada em s, WS e privado em MB): 20/2,94/37,7/72,3 ·
100/7,13/38,7/75,5 · 200/11,55/35,2/74,5 · 300/16,20/44,4/78,7 · 400/20,78/40,6/75,4 ·
500/25,80/36,5/75,6 · 600/30,66/43,4/75,4. Todas as 30 amostras com o observador
vivo.

## 6. Parse / frontmatter — PASS

Comando:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\skills\dsh-maintenance\tests\test-parse.ps1
```

```
OK install.ps1 (1579 tokens)
OK scripts\lib.ps1 (4108 tokens)
OK scripts\observador.ps1 (5476 tokens)
OK scripts\supervisor-dsh.ps1 (951 tokens)
OK scripts\supervisor-observador.ps1 (1037 tokens)
OK scripts\supervisor-runner.ps1 (1526 tokens)
OK tests\_lib-test.ps1 (379 tokens)
OK tests\test-captura-killer.ps1 (1062 tokens)
OK tests\test-hung.ps1 (503 tokens)
OK tests\test-install.ps1 (744 tokens)
OK tests\test-parse.ps1 (717 tokens)
OK tests\test-rotacao.ps1 (407 tokens)
OK tests\test-supervisor.ps1 (678 tokens)
OK uninstall.ps1 (282 tokens)
OK   name: dsh-maintenance
OK   frontmatter description presente
ASCII puro em todos os .ps1 (PS 5.1 sem BOM le como ANSI)
RESULTADO: PASS
```

## 7. Classificação `hung` (porta aberta, HTTP sem resposta) — PASS

Comando:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\skills\dsh-maintenance\tests\test-hung.ps1
```

Sobe um servidor TCP mudo na porta 38080 (processo node descartável), aponta o
observador para ele e espera > 20 s sem resposta:

```
veredito  : hung
confianca : alta
resumo    : Porta 38080 em LISTEN com o alvo (pid 13072) vivo, mas HTTP / sem resposta por mais de 20 s.
RESULTADO: PASS
```

## 8. Supervisor do observador (lacuna + reerguer) — PASS

Teste manual com `-IntervalSec 5 -HeartbeatMaxSec 10`: observador iniciado,
processo morto de propósito; 5 s depois o supervisor registrou e reergueu.

```json
{"ts":"2026-11-11T19:24:35.4894861-03:00","tipo":"observador_morto","ultimo_heartbeat":"2026-11-11T19:24:32.183-03:00","lacuna_s":3,"acao":"reiniciado","novo_pid":27144,"heartbeat_max_s":10}
```

`estado.json` novo: `pid=27144`, heartbeat fresco (3,1 s de atraso). Isso cobre o
requisito de "se o observador morrer, registrar a lacuna e reerguer".

## 9. DSH intocado

Durante toda a bateria, `netstat -ano` mostrou `127.0.0.1:3080 LISTENING 29072`
e `curl` respondeu `401` em ~1–2 ms. Nenhum script de teste chama
`taskkill`/`Stop-Process` no PID do DSH; os únicos PIDs encerrados são os
descartáveis e os processos do próprio observador/supervisor de teste.
