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
>
> Na revisão 2 (issue #33) isso virou um teste separado e explícito:
> `test-captura-taskkill-real.ps1` prova o `taskkill` real 3/3 em shell normal e
> sai com **SKIP (exit 3)** neste sandbox. Ver seção R2.

## R2. Revisão 2 (issue #33) — 3 testes novos

O problema medido na verificação da PR #31: o `taskkill.exe` que **consegue**
matar vive ~117–165 ms (seção 1c) e o poll antigo rodava no **mesmo thread** do
loop do observador (snapshot + `Get-Process` + PEB + cadeia de ancestrais), então
o intervalo efetivo passava de 100 ms e o processo curto escapava. O motor novo
(`scripts\captura.ps1`) desacopla: thread dedicada de
`NtQuerySystemInformation` a cada ~25 ms fazendo **só** diff de PID/PPID/create
time, com nome/cmdline/PEB/ancestrais resolvidos por uma fila de enriquecimento
(no JSONL, `ancestors[]` só vai para suspeito/filho do alvo e o `exit` comum vem
sem `cmdline` — economia de disco).
Nenhum dos três testes abaixo toca no DSH: o alvo é um `powershell.exe` descartável
e o observador usa `-DataDir` próprio (dentro de `work\<ticket>\.out\`).

| Teste (em `skills\dsh-maintenance\tests\`) | O que prova | Evidência esperada | Exit |
|---|---|---|---|
| `test-captura-curta.ps1` | captura de processos curtos (`cmd.exe /c exit`) e de processos de ~120 ms com o poll novo | taxa de captura ≥ 95% em 50 processos, case por PID no `processos-*.jsonl`, mais a taxa medida da 2ª leva (~120 ms) | `0` = PASS, `1` = FAIL |
| `test-disco.ps1` | volume de disco sob churn de 2 min e o teto diário funcionando | bytes/min medidos → projeção MB/dia; com `-MaxDayMb` pequeno: gravações recusadas + linha em `resumo-*.jsonl` | `0` = PASS, `1` = FAIL |
| `test-captura-taskkill-real.ps1` | o aceite da issue: `taskkill /PID <alvo> /F` **real** capturado e classificado | 3/3 execuções com `veredito=killed`, `assassino.nome` com `taskkill`, `ppid > 0`, `cmdline` com `/PID <alvo>` e registro `event=start` do taskkill na `processos-*.jsonl` | `0` = PASS (3/3), `1` = FAIL, `2` = pré-requisito ausente, `3` = SKIP |

Comandos, a partir da raiz do clone:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\skills\dsh-maintenance\tests\test-captura-curta.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\skills\dsh-maintenance\tests\test-disco.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\skills\dsh-maintenance\tests\test-captura-taskkill-real.ps1
```

> `test-captura-curta` e `test-disco` terminam com `0` (PASS) / `1` (FAIL) —
> conferido nos próprios scripts; `test-captura-taskkill-real` usa também `2`
> (observador ou `taskkill.exe` ausente) e `3` (SKIP). As seções de evidência de
> cada teste só são preenchidas com execução real — enquanto não houver, este
> documento não traz taxa de captura nem MB/dia inventados.

### R2a. `test-captura-taskkill-real.ps1` — o aceite (só o Lead roda em shell normal)

O script faz **3 execuções independentes**. Em cada uma: cria o alvo descartável
(`powershell -NoProfile -Command "Start-Sleep 300"`), sobe o observador com
`-DataDir` próprio + `-TargetPid <alvo>` + `-DurationSeconds 150`, espera o
heartbeat, espera ~1 s, executa `taskkill.exe /PID <alvo> /F` guardando a saída e
o instante, espera o veredito (até 15 s) e confere no `veredito-*.json`:

| Check | Regra |
|---|---|
| classificação | `veredito = killed` |
| alvo | `alvo.pid` = PID do alvo descartável |
| assassino | `assassino.nome` contém `taskkill` |
| pai | `assassino.ppid > 0` |
| linha de comando | `assassino.cmdline` contém `/PID <alvo>` (o PID do alvo sozinho é aceito como *fallback*, com `AVISO` impresso) |
| prova no JSONL | existe `event=start` com `name` de taskkill e o PID do alvo em `processos-*.jsonl` |

Cada execução imprime PID do taskkill, `ppid`, `cmdline`, veredito, tempo
morte→veredito e o `lifetime_ms` do registro de `exit`. `PASS` só com **3/3**
(exit 0); qualquer falha real → exit 1 com o resumo das falhas. Defaults dos
timeouts: `-TimeoutSec 60` (heartbeat, igual aos outros testes) e
`-VerdictTimeoutSec 15` (veredito) — ambos ajustáveis por parâmetro.

O caminho literal pedido pela issue também existe como forwarder curto
(`repo\tests\test-captura-taskkill-real.ps1`), que repassa o `-RepoRoot` e devolve
o mesmo exit code:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\test-captura-taskkill-real.ps1
```

**Neste shell do agente o taskkill é bloqueado** (`ERRO: Acesso negado`; exit 1).
O script detecta isso, imprime o SKIP e sai com exit **3** — não finge PASS:

```
[21:13:16]    alvo descartavel pid=17992
[21:13:16]    observador pid=31072 (DataDir proprio, so leitura)
[21:13:17]    heartbeat fresco; alvo fixado
[21:13:18]    assassinato: taskkill.exe /PID 17992 /F
     taskkill: ERRO: Acesso negado
     taskkill: System.Management.Automation.RemoteException
[21:13:19]    taskkill NAO matou (exit=1); registros de taskkill capturados nesta execucao: 0
RESULTADO: SKIP (taskkill bloqueado neste shell - rodar em shell normal/Explorer)
```

(A linha `System.Management.Automation.RemoteException` é ruído do
`ErrorRecord` que o PowerShell anexa à saída do executável — não é erro do teste.)

Ou seja: **no sandbox do agente o aceite não pode ser provado**; o que se prova,
às vezes, é só a **captura** do `taskkill.exe` (ver R2b). A prova de classificação
com `taskkill` real é do Lead, em shell normal/Explorer. Não existe resultado 3/3
registrado aqui — quem rodar em shell normal deve colar a saída real nesta seção.

### R2b. O que o sandbox já prova (captura, não aceite) — com o motor novo

Execução do teste acima em 2026-11-11 21:16, com o observador já na revisão 2
(`versao` 1.1, motor `nqsi25`, poll de 25 ms). O `taskkill` foi bloqueado (exit 1)
e o alvo continuou vivo, então **não houve `killed`** — mas a captura e o
preenchimento do alvo funcionaram:

| Medida | Valor observado |
|---|---|
| motor | `motor de captura ativo: poll 25 ms (nqsi), visiveis=55` |
| baseline | `{"event":"baseline","count":55,...}` |
| `target_fixed` | `ppid=22704` e `cmdline` do alvo legíveis (fonte `peb`, `error` nulo) |
| `taskkill.exe` | `event=start` com `pid=24424`, `ppid=22704`, `seen_ms=0`; `exit` com `lifetime_ms=89` e `alvo_vivo_no_fim=true` |

Trecho real (encurtado) da `processos-*.jsonl`:

```json
{"ts":"2026-11-11T21:16:51.223-03:00","event":"start","pid":24424,"ppid":22704,"name":"taskkill.exe","cmdline":"","start":"2026-11-11T21:16:51.1726988-03:00","suspect":true,"reasons":["nome:taskkill.exe"],"target_pid":28372,"fonte":"nqsi25","error":"QueryFullProcessImageName:5","poll_ms":25,"seen_ms":0}
```

O `cmdline` veio vazio porque o `taskkill.exe` disparado do shell restrito roda
com token limitado e a leitura falhou **com motivo explícito**
(`QueryFullProcessImageName:5`) — não silencioso. O `alvo_vivo_no_fim=true` marcou
o processo como **inocente**, que é o correto: ele não matou o alvo. Em um shell
normal o mesmo registro deve vir com `cmdline` contendo `/PID <alvo>` — é
exatamente isso que o aceite exige.

> Medição desta execução: o `taskkill` **bloqueado** ficou visível por
> `lifetime_ms=89` e foi pego no primeiro tick (`seen_ms=0`). O número antigo de
> "< 50 ms" para taskkill que falha (seção 1c) não vale como regra geral — o que
> importa é que, no shell normal, o `taskkill` que mata vive ~117–165 ms.

## 0. Correções da issue #32 (revisão da PR #31) — PASS

A verificação independente da PR #31 reprovou `test-captura-killer` e
`test-hung`: o observador levava ~22 s no primeiro ciclo (PEB/commandline por
processo) e os testes esperavam 15–20 s pelo heartbeat. Correções na **mesma
branch** `agent/dsh-maintenance`:

1. heartbeat inicial gravado **antes** do primeiro `Invoke-ProcPoll` e antes de
   eventos/sessões;
2. primeiro poll virou baseline barato: PIDs/PPIDs por
   `NtQuerySystemInformation`, sem PEB/commandline por processo, com **uma**
   linha `{"event":"baseline","count":N,...}` no `processos-*.jsonl`;
3. `FileStream` do JSONL sem buffer (`bufferSize=1`) + flush explícito, para não
   depender do buffer interno do runtime;
4. `-TimeoutSec` default dos testes frágeis derivado da medição: **60 s** em
   `test-captura-killer` e `test-hung` (antes 20 s / 45 s e um `Wait-Heartbeat`
   fixo de 15 s).

### 0a. Inicialização com 150 processos extras (A/B, mesma máquina)

Método (`.tmp\ab-init.ps1`, não versionado): sobe 150 `ping.exe` parados, inicia o
observador com `-DataDir` limpo e mede do `Start-Process` até o `estado.json` e
até o primeiro snapshot. Código antigo = HEAD `ab57d6e`; código novo = branch.

| Métrica (338–340 processos visíveis) | Antigo | Novo |
|---|---|---|
| primeiro `estado.json` (heartbeat) | **15,9 s** | **0,59 s** |
| primeiro `snapshot-*.jsonl` | 15,91 s | 0,94 s |
| 1º ciclo `processos-*.jsonl` | **342 linhas / 488.425 bytes** | **2 linhas / 408 bytes** |

Na verificação do Lead (issue #32, 314 processos) o antigo deu **21,6 s** e
**305.184 bytes** no 1º ciclo — mesma ordem de grandeza; a diferença é a carga da
máquina. Sem os 150 processos extras (39 visíveis) o heartbeat do código novo
fica em **0,56–0,59 s**, e o custo do 1º ciclo não depende do número de
processos.

### 0b. Durabilidade do JSONL com o observador vivo

`test-captura-killer` agora lê `processos-*.jsonl` com o observador **vivo**,
imprime tamanho/número de linhas e mostra a última linha; falha se não houver
linha:

```
[20:25:52] durabilidade (observador vivo): processos bytes=483 linhas=2
[20:25:52] ultima linha ja visivel: {"ts":"2026-11-11T20:25:24.864-03:00","event":"baseline","count":41,...}
```

Conferência extra (leitura por stream, de outro processo, com o observador vivo):
`eventos` 249 B, `hash-sessoes` 23.633 B, `snapshot` 659 B e `processos` 38.671 B
legíveis. O "arquivo com 0 byte" observado com `Get-ChildItem` é **metadata de
diretório defasado** enquanto o arquivo está aberto para append — o conteúdo já
estava gravado e é legível por `Get-Content`. O writer ganhou `FileStream` sem
buffer + flush explícito e o teste passou a cobrir essa leitura.

### 0c. Latência morte → veredito

`test-captura-killer` mede do início do kill até o `gerado_em` do veredito e
exige ≤ 5 s (aceite da issue). Medições na bateria final: **0,69 s / 0,72 s /
0,69 s** (runs 1–3); na execução avulsa de validação: 0,71 s.

### 0d. Bateria 3x dos 6 testes (2026-11-11, após as correções)

Todos os 18 comandos terminaram com **exit 0** e `RESULTADO: PASS`:

| Teste | run 1 | run 2 | run 3 |
|---|---|---|---|
| test-parse | exit 0 / PASS (0,5 s) | exit 0 / PASS (0,4 s) | exit 0 / PASS (0,4 s) |
| test-rotacao | exit 0 / PASS (9,2 s) | exit 0 / PASS (9,2 s) | exit 0 / PASS (9,2 s) |
| test-supervisor | exit 0 / PASS (4,2 s) | exit 0 / PASS (4,1 s) | exit 0 / PASS (4,1 s) |
| test-captura-killer | exit 0 / PASS (3,0 s) | exit 0 / PASS (3,0 s) | exit 0 / PASS (3,0 s) |
| test-install | exit 0 / PASS (15,7 s) | exit 0 / PASS (15,6 s) | exit 0 / PASS (15,5 s) |
| test-hung | exit 0 / PASS (30,6 s) | exit 0 / PASS (30,5 s) | exit 0 / PASS (30,5 s) |

Comandos exatamente como documentados, a partir da raiz do clone
(`F:\ai\_lab\superagent-nativo\watcher\work\32`).

### 0e. Custo após as correções (180 s, 3080 real)

| Métrica | Medido | Limite da issue |
|---|---|---|
| CPU | **5,05 % de 1 núcleo** = 0,21 % da máquina | < 1 % |
| RAM working set | média **40,5 MB**, máxima **60,3 MB** | < 80 MB |
| RAM commit privado | média **72,4 MB**, máxima **75,6 MB** | < 80 MB |
| Volume steady-state | **17,5 MB/dia** projetado (pouca troca de processos) | < 200 MB/dia |
| Custo inicial (5 arquivos, 1º ciclo) | **2.283 bytes** | — |

A medição de 10 min da seção 5 (ambiente com ~300 processos) continua valendo
como pior caso (~45 MB/dia).

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
