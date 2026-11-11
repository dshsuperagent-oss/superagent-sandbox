# dsh-observador — documentação técnica

Observador permanente do DSH diário (Web UI em `http://127.0.0.1:3080`) e
supervisor de processo, escritos em **PowerShell 5.1**, **sem admin**, com todos
os dados em `F:`. Existem para responder, na próxima queda, **quem** encerrou o
DSH (nome, PID, pai e instante) ou **por que** ele caiu — coisa que em
2026-11-11 ficou indeterminada (ver
[RETROSPEC-2026-11-11](../../docs/dsh-maintenance/RETROSPEC-2026-11-11.md)).

Uso operacional no dia a dia (o que fazer quando o DSH cai): [SKILL.md](SKILL.md).

## Princípios

- **Fora da árvore do DSH.** O observador é iniciado no logon pela pasta Startup
  do usuário; se o DSH morrer, ele continua gravando.
- **Nunca mata o DSH.** O observador e o supervisor do DSH não têm `taskkill` nem
  `Stop-Process`. `Stop-Process` aparece somente no `install.ps1`/`uninstall.ps1` e
  no `supervisor-observador.ps1`, sempre restrito a processos cujo *commandline*
  contém o caminho de instalação **e** o nome do próprio script (observador ou
  supervisor do observador) — nunca no node da 3080.
- **Não reinicia o DSH.** Quem sobe servidor morto é
  `F:\ai\_lab\dsh-saude\watchdog-3080.ps1`. O observador só registra; o
  `supervisor-dsh.ps1` grava ExitCode + instante da saída e só reinicia com
  `-Restart` explícito, depois de gravar o registro.
- **Grava barato e não bloqueia:** append em JSONL, rotação por dia
  (`AAAA-MM-DD`), retenção de 7 dias, sem reescrever arquivo.

## O que é observado

| Fluxo | Intervalo | Arquivo | Pergunta que responde |
|---|---|---|---|
| Snapshot do alvo | 2 s | `snapshot-AAAA-MM-DD.jsonl` | o DSH estava vivo? respondendo? quantas conexões? |
| Diff de processos | 100 ms (1º ciclo: baseline) | `processos-AAAA-MM-DD.jsonl` | **quem** apareceu/saiu, com PID, PPID, commandline e ancestrais |
| Event Log | 30 s | `eventos-AAAA-MM-DD.jsonl` | Kernel-Power, WER/AppCrash, erros de serviço, TaskScheduler |
| Sessões | 30 s | `hash-sessoes-AAAA-MM-DD.jsonl` | a conversa parou de gravar em que instante? |
| Heartbeat | 5 s | `estado.json` | o próprio observador está vivo? |
| Lacunas | no evento | `lacunas-AAAA-MM-DD.jsonl` | o observador ficou fora e por quanto tempo |
| Veredito | por morte | `veredito-AAAAMMDD-HHmmss.json` | classificação + confiança + evidências |

## Árvore de diretórios

```
F:\ai\_lab\dsh-saude\observador\
├─ scripts\
│  ├─ lib.ps1                     # PEB (CommandLine/PPID), ProcSnap, JSONL, netstat
│  ├─ observador.ps1              # loop principal (5 fluxos + heartbeat)
│  ├─ supervisor-observador.ps1   # reergue o observador e registra lacunas
│  ├─ supervisor-dsh.ps1          # sobe o DSH com -PassThru, grava ExitCode + instante
│  └─ supervisor-runner.ps1       # inicia o alvo e carimba stdout/stderr
├─ observacao\
│  ├─ snapshot-2026-11-11.jsonl
│  ├─ processos-2026-11-11.jsonl
│  ├─ eventos-2026-11-11.jsonl
│  ├─ hash-sessoes-2026-11-11.jsonl
│  ├─ lacunas-2026-11-11.jsonl
│  ├─ estado.json
│  └─ veredito-20261111-164926.json
├─ logs\
│  ├─ dsh-console-timestamped.log      # stdout+stderr do DSH, com timestamp
│  ├─ supervisor-2026-11-11.jsonl      # início/saída do DSH sob supervisão
│  └─ supervisor-observador-2026-11-11.log
└─ README.md

skills\dsh-maintenance\              # no repo (instalador fica aqui)
├─ install.ps1                       # idempotente, sem admin
├─ uninstall.ps1                     # para processos, remove Startup, mantém logs
├─ SKILL.md
├─ scripts\...
├─ tests\...
└─ README.md
```

Entrada na pasta Startup do usuário (dispara no logon, fora da árvore do DSH):

```
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\DSH - observador 3080.cmd
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\DSH - supervisor observador 3080.cmd
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\DSH - supervisor-dsh 3080.cmd   (opcional, -SuperviseDsh)
```

## Formatos dos artefatos

Os exemplos abaixo são **ilustrativos** (valores de forma, não medições reais do
dia). `ts` e `hora` são ISO-8601 com offset local.

### `snapshot-AAAA-MM-DD.jsonl` — a cada 2 s

```json
{"ts":"2026-11-11T18:13:59-03:00","obs_pid":7312,"target":{"pid":5660,"alive":true,"start":"2026-11-11T10:02:14-03:00","cpu_s":412.37,"rss_mb":286.4,"handles":1187,"threads":23},"port":3080,"listen":true,"http":{"code":"401","ms":2},"conn":{"LISTEN":1,"ESTABLISHED":4,"FIN_WAIT_2":0,"CLOSE_WAIT":1},"uptime_s":29505}
```

| Campo | Significado |
|---|---|
| `ts` | instante da amostra (observador) |
| `obs_pid` | PID do observador que gravou |
| `target.pid` / `target.alive` | PID do node do DSH e se estava vivo |
| `target.start` | início do processo do DSH (para detectar troca de PID) |
| `target.cpu_s`, `rss_mb`, `handles`, `threads` | CPU acumulada (s), memória, handles, threads |
| `port`, `listen` | porta 3080 e se havia LISTEN |
| `http.code`, `http.ms` | resposta de `GET /` via `curl` (código + latência). `401` = normal |
| `conn.LISTEN` / `ESTABLISHED` / `FIN_WAIT_2` / `CLOSE_WAIT` | conexões na 3080 por estado TCP |
| `uptime_s` | segundos desde o início do **observador** (não é o uptime do DSH) |

Queda típica vista aqui: `alive` vira `false` e o `http.code` vai a `000` na mesma
amostra; `hung` = `listen:true` com `http.code:"000"` (sem resposta dentro do
timeout de 4 s do probe) por mais de 20 s consecutivos.

### `processos-AAAA-MM-DD.jsonl` — poll de 100 ms, só o diff

No boot, antes do primeiro diff, o observador grava **uma** linha
`{"event":"baseline","count":N,...}` com a contagem de processos vinda da API
nativa (`NtQuerySystemInformation`, sem PEB). Processos que já existiam não são
"novos": não há dump de PIDs/commandline de todos no startup. Só quem nasce
depois do baseline entra com PID/PPID/commandline/ancestrais. É isso que mantém o
primeiro ciclo barato (ver "Custo medido") e impede o arquivo de crescer com
centenas de linhas no start.

```json
{"ts":"2026-11-11T16:49:23-03:00","event":"start","pid":8844,"ppid":6120,"name":"taskkill","cmdline":"taskkill /PID 5660 /T /F","start":"2026-11-11T16:49:23-03:00","ancestors":[{"pid":6120,"ppid":4896,"name":"powershell","cmdline":"powershell -File restart-dsh.ps1"},{"pid":4896,"ppid":400,"name":"cmd","cmdline":"cmd /c ..."}],"suspect":true,"reasons":["nome:taskkill","cmdline_suspeita","menciona_pid_alvo"],"target_pid":5660,"fonte":"peb","error":null}
```

| Campo | Significado |
|---|---|
| `event` | `baseline` (1º ciclo, só contagem), `start` (novo), `exit` (saiu), `target_adopted` (alvo descoberto pela porta) ou `target_fixed` (alvo veio por `-TargetPid`) |
| `pid`, `ppid`, `name`, `start` | identidade do processo |
| `cmdline` | linha de comando completa (PEB) |
| `ancestors[]` | cadeia de pais (quem mandou), com `pid`, `ppid`, `name`, `cmdline` e `error` quando a leitura falhou |
| `suspect` / `reasons[]` | o processo casou um padrão de risco (`nome:taskkill`, `cmdline_suspeita`, `menciona_pid_alvo`, `descendente_do_alvo`) |
| `target_pid` | PID do DSH no momento da captura |
| `alvo_vivo_no_fim` | (só no `exit`) `true` = o alvo ainda estava vivo quando o suspeito saiu; o observador **não** cita esse processo como assassino |

Padrões que marcam `suspect:true` (obrigatórios na issue): `taskkill`, `powershell`,
`node` e qualquer commandline com `3080`, `taskkill`, `Stop-Process` ou o PID do
DSH. É este arquivo que transforma uma queda desconhecida em `killed` com
nome/PID/PPID/commandline.

### `eventos-AAAA-MM-DD.jsonl` — a cada 30 s

```json
{"ts":"2026-11-11T18:14:05-03:00","log":"System","id":41,"level":"Critical","provider":"Microsoft-Windows-Kernel-Power","time":"2026-11-11T18:13:58-03:00","record_id":228841,"message":"O sistema foi reiniciado sem desligar primeiro corretamente."}
```

| Campo | Significado |
|---|---|
| `ts` | quando o observador leu |
| `log` | `System`, `Application` ou `TaskScheduler/Operational` |
| `id`, `provider`, `level` | identificação do evento |
| `time` | horário do evento **no Event Log** (não é o de leitura) |
| `record_id` | ID do registro (para citar/correlacionar) |
| `message` | texto do evento (truncado) |

Interessam: Kernel-Power 41/1074/6008, WER/AppCrash, erros de serviço e execuções
de tarefas de restart.

### `hash-sessoes-AAAA-MM-DD.jsonl` — a cada 30 s

```json
{"ts":"2026-11-11T18:13:30-03:00","count":104,"changed":[{"path":"C:\\Users\\carlos\\.dsh\\sessions\\--F-ai--\\f3a1c9\\session.v4.jsonl.zstd","mtime":"2026-11-11T18:13:27-03:00","size":184320,"quick_hash":"9f2c41d0"}]}
```

| Campo | Significado |
|---|---|
| `count` | quantas sessões foram vistas |
| `changed[]` | **apenas** as sessões cujo mtime/tamanho mudou desde o ciclo anterior (path + mtime + size + hash parcial) |

O primeiro ciclo depois de iniciar lista todas as sessões uma vez (baseline);
depois disso o registro é pequeno (só o que mudou). É isso que mantém o volume
diário baixo.

**Limite honesto:** o conteúdo das sessões é zstd e não é lido — dá para saber
*quando* a conversa parou de gravar, nunca *o que* foi dito.

### `estado.json` — heartbeat a cada 5 s

```json
{"pid":7312,"iniciado":"2026-11-11T18:59:58-03:00","ultimo_ciclo":"2026-11-11T19:07:21-03:00","versao":"1.0.0","alvo_pid":5660,"porta":3080,"data_dir":"F:\\ai\\_lab\\dsh-saude\\observador","ciclos":86,"erros":0,"amostras":{"snapshot":209,"processos":4200,"eventos":14,"sessoes":14}}
```

`ultimo_ciclo` com mais de **15 s** de atraso indica observador atrasado; o
`supervisor-observador.ps1` só considera falha e reergue quando passa de
**45 s** (`-HeartbeatMaxSec`, default). Entre 15 s e 45 s ainda não há lacuna
gravada: investigue o processo e o log do supervisor antes de concluir.

O **primeiro** `estado.json` é gravado no startup, **antes** de qualquer varredura
cara (diff de processos/PEB, snapshot, eventos, sessões). O heartbeat fica fresco
em < 2 s e, se o DSH morrer durante o boot, já existe registro de que o
observador estava vivo e qual alvo seguia.

### `veredito-AAAAMMDD-HHmmss.json` — gerado a cada morte detectada

```json
{
  "versao": "1.0",
  "veredito": "killed",
  "confianca": "alta",
  "gerado_em": "2026-11-11T16:49:26-03:00",
  "causa": "processo_alvo_desapareceu",
  "alvo": {"pid": 5660, "nome": "node", "start": "2026-11-11T10:02:14-03:00", "porta": 3080, "fixado": false},
  "resumo": "Encerrado por taskkill (pid 8844, pai 6120): taskkill /PID 5660 /T /F",
  "assassino": {"pid": 8844, "ppid": 6120, "nome": "taskkill", "cmdline": "taskkill /PID 5660 /T /F", "ancestrais": [{"pid": 6120, "ppid": 4896, "name": "powershell"}], "fonte": "processos-2026-11-11.jsonl", "linha": 1412},
  "evidencias": [
    {"fonte": "processos-2026-11-11.jsonl", "linha": 1412, "hora": "2026-11-11T16:49:23-03:00", "trecho": "{\"event\":\"start\",\"pid\":8844,\"name\":\"taskkill\",\"target_pid\":5660}"}
  ],
  "timeline": [{"hora": "2026-11-11T16:49:23-03:00", "evento": "assassino", "detalhe": "taskkill pid=8844"}],
  "limitacoes": ["Sem admin nao ha ETW/WMI process events/4688: processos com vida menor que o intervalo de poll (100 ms) podem escapar."]
}
```

Campo `assassino` é `null` quando não há assassino identificado. `limitacoes[]` é
obrigatório de ler: diz exatamente o que o veredito **não** prova. `confianca`
alta exige `cmdline` citando o PID do alvo (ou `taskkill`); um `killed` sem
`assassino` preenchido e sem ExitCode do supervisor deve ser rebaixado.

### `lacunas-AAAA-MM-DD.jsonl` — buracos na vigilância

```json
{"ts":"2026-11-11T19:05:10-03:00","tipo":"observador_morto","ultimo_heartbeat":"2026-11-11T19:04:42-03:00","lacuna_s":28,"acao":"reiniciado","novo_pid":8812,"heartbeat_max_s":45}
```

`tipo` é `observador_morto` (processo sumiu) ou `heartbeat_parado` (vivo mas sem
gravar). `acao` é `reiniciado`, `observador_travado_encerrado_e_reiniciado`,
`falha_ao_encerrar_observador_travado`, `reinicio_falhou` ou `nenhuma` (com
`-NoStart`). Se houver lacuna cobrindo o instante da queda, o veredito daquela
janela é `unknown` — e isso deve ser dito, não escondido.

### `logs\dsh-console-timestamped.log` e `logs\supervisor-AAAA-MM-DD.jsonl`

O `supervisor-runner.ps1` inicia o DSH com `Start-Process -PassThru`, guarda o
handle e carimba cada linha de stdout/stderr:

```
=== SUPERVISOR INICIO 2026-11-11 16:48:59.120 exe=node ===
2026-11-11 16:49:01.233 dsh web: http://127.0.0.1:3080/?token=...
2026-11-11 16:49:23.417 [stderr] Error: ...
=== DSH EXIT code=-1 em 2026-11-11 16:49:23.418 duracao_s=24.3 ===
```

```json
{"ts":"2026-11-11T16:49:23.420-03:00","event":"dsh_exit","runner_pid":7712,"dsh_pid":5660,"exit_code":-1,"runner_exit":-1,"started":"2026-11-11T16:48:59.120-03:00","ended":"2026-11-11T16:49:23.420-03:00","log":"...\\dsh-console-timestamped.log","exit_file":"...\\supervisor-exit-20261111-164859.json"}
```

Regra de leitura: **exit != 0 sem stack = encerrado de fora**; **exit != 0 com
stack = crash**. ExitCode `-1` (`4294967295`) é o típico de processo morto por
`TerminateProcess`/`taskkill /F`. O supervisor não reinicia o DSH sozinho
(só com `-Restart`, e depois de gravar o registro).

## Como interpretar um veredito

1. Abra o `veredito-*.json` mais recente (`Sort-Object LastWriteTime -Descending`).
2. Olhe `veredito` + `confianca` na tabela abaixo.
3. **Confirme abrindo a evidência citada**: `fonte` + `linha` + `hora`. Se a linha
   não existir ou o horário não casar, o veredito não vale.
4. Leia `limitacoes[]` antes de escrever qualquer conclusão.
5. Cite no report no formato `arquivo:linha (horário)`.

| Veredito | Significado | Confiança alta quando | O que ainda pode enganar |
|---|---|---|---|
| `killed` | alguém encerrou o DSH | o registro do assassino em `processos.jsonl` tem `cmdline` citando o PID do DSH (ou nome `taskkill`) **e** `ppid`/`ancestrais[]` legíveis — o código pontua e exige score ≥12 para `alta` | assassino elevado (PEB ilegível) ou processo que viveu < 100 ms |
| `crashed` | o DSH morreu sozinho | `ExitCode != 0` **e** stack no console com timestamp, ou WER/AppCrash em `eventos.jsonl` | exit 1 sem stack = encerrado, não crash |
| `hung` | vivo, mas sem responder | `listen:true` e `http.code:"000"` por mais de 20 s em `snapshot.jsonl` | lentidão momentânea de 1–2 amostras não é hang |
| `unknown` | dados insuficientes | — (é o veredito da falta de prova) | lacuna do observador, queda entre amostras, sem registro de processo/evento |

`confianca`: `alta` = evidência direta e casada (PID, linha, horário); `media` =
indício forte (ex.: sessão parou de gravar às 18:13:23 e o processo sumiu do
snapshot, sem registro de quem matou); `baixa` = só sintoma.

## Install e uninstall

Instalação (idempotente, sem admin, sem UAC, sem escrever em `C:`):

```powershell
# a partir da raiz do clone do repo
powershell -NoProfile -ExecutionPolicy Bypass -File .\skills\dsh-maintenance\install.ps1
```

O instalador copia os scripts para `F:\ai\_lab\dsh-saude\observador\scripts\`,
cria/atualiza as entradas `DSH - observador 3080.cmd` e
`DSH - supervisor observador 3080.cmd` na pasta Startup do usuário,
sobe observador + supervisor, confirma pelo `estado.json` e imprime as **3
primeiras linhas de cada arquivo** como prova. Rodar de novo não duplica Startup
nem processos: ele encerra as instâncias anteriores *do próprio observador*
(identificadas pelo caminho exato do script) antes de subir as novas.

### Para o `ExitCode` existir em produção (passo manual)

O `supervisor-dsh.ps1` só captura ExitCode do DSH que **ele** iniciou. Hoje o
boot diário (`F:\ai\_lab\boot\dsh-diario.ps1`) e o vigia chamam
`iniciar-web.bat` direto, então o DSH nasce fora do supervisor. Para ativar a
captura em produção, o Lead troca a chamada de `iniciar-web.bat` por:

```powershell
Start-Process powershell.exe -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',
  'F:\ai\_lab\dsh-saude\observador\scripts\supervisor-dsh.ps1','-DataDir',
  'F:\ai\_lab\dsh-saude\observador')
```

(ou instala com `-SuperviseDsh`, que cria a entrada de Startup
`DSH - supervisor-dsh 3080.cmd` com `-OnlyIfDown`; nesse caso o supervisor só
assume quando vence a corrida do logon, porque **nunca** mata um DSH já no ar).
Enquanto esse passo não for feito, o observador continua classificando
`killed`/`hung`/`unknown`, mas não há `exit_code`/instante do supervisor — e o
veredito diz isso nas `limitacoes[]`.

Conferência depois de instalar:

```powershell
Get-Content 'F:\ai\_lab\dsh-saude\observador\observacao\estado.json' -Raw | ConvertFrom-Json |
  Select-Object pid, iniciado, ultimo_ciclo, ciclos, erros, alvo_pid
Get-ChildItem 'F:\ai\_lab\dsh-saude\observador\observacao' | Select-Object Name, Length, LastWriteTime
```

Desinstalação (para processos do observador e remove a entrada da Startup;
**mantém** os logs e a pasta `observacao\` para perícia):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\skills\dsh-maintenance\uninstall.ps1
```

## Custo medido

Medição de 10 min (600 s, 30 amostras a cada 20 s) com o observador monitorando a
3080 real, Windows 11, 24 processadores lógicos:

| Métrica | Medido (10 min) | Limite da issue |
|---|---|---|
| CPU média do observador | **0,198 % da máquina** (28,58 s de CPU em 600 s = 4,76 % de 1 núcleo) | < 1 % |
| RAM (working set) | média **39,4 MB**, máxima **47,0 MB** | < 80 MB |
| RAM (commit privado) | média **74,7 MB**, máxima **78,7 MB** | < 80 MB |
| Volume gravado | **~45 MB/dia** projetado (snapshot 13,6 MB + processos ~26 MB + sessões/eventos/logs) | < 200 MB/dia |
| Impacto no DSH | probe é `GET /` somente leitura; DSH respondeu 401 em ~1–4 ms; o probe com spawn do `curl` mede 12,7 ms médio / 45 ms máx | — |

O polling de processos é de 100 ms (contra 2 s do snapshot) para não perder o
assassino; é o item mais caro. Para caber em <80 MB de working set, o observador
faz `GC.Collect()` + `EmptyWorkingSet` no próprio processo **1×/min** (`-TrimSec
60`); o commit privado fica ~75 MB e o working set ~40 MB. Isso não toca no DSH
nem em outro processo. Números brutos da medição em
[`TESTES.md`](../../docs/dsh-maintenance/TESTES.md#5-custo-10-min--pass).

### Inicialização e primeiro dump (issue #32, medição A/B)

Medido com 150 `ping.exe` extras vivos (338–340 processos visíveis), mesmo
ambiente para o código antigo (HEAD `ab57d6e`) e o novo:

| Métrica | Código antigo | Código novo |
|---|---|---|
| primeiro `estado.json` (heartbeat) | **15,9 s** | **0,59 s** |
| primeiro `snapshot-*.jsonl` | 15,91 s | 0,94 s |
| 1º ciclo de `processos-*.jsonl` | **342 linhas / 488.425 bytes** | **2 linhas / 408 bytes** |

Sem os 150 processos extras (39 visíveis) o heartbeat fica em **0,56–0,59 s**.
O primeiro ciclo antigo chegou a **21,6 s / 305.184 bytes** na verificação do Lead
(issue #32, 314 processos). Com o baseline nativo o custo do primeiro ciclo não
depende do número de processos: o total inicial dos 5 arquivos ficou em
**2.283 bytes**.

Steady-state após as correções (180 s monitorando a 3080 real, 24 processadores
lógicos):

| Métrica | Medido (180 s) | Limite da issue |
|---|---|---|
| CPU | **5,05 % de 1 núcleo** = 0,21 % da máquina | < 1 % |
| RAM working set | média **40,5 MB**, máxima **60,3 MB** | < 80 MB |
| RAM commit privado | média **72,4 MB**, máxima **75,6 MB** | < 80 MB |
| Volume | **17,5 MB/dia** projetado (pouca troca de processos nesta sessão) | < 200 MB/dia |

A medição de 10 min (ambiente com ~300 processos) continua valendo como pior
caso (~45 MB/dia); o baseline reduziu o pico do startup, não o steady-state.

## Testes (o que já foi provado e como)

Cada item abaixo é provado com trecho de arquivo, não com "funciona". Os testes
ficam em `skills\dsh-maintenance\tests\` e não tocam no DSH:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\skills\dsh-maintenance\tests\test-captura-killer.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\skills\dsh-maintenance\tests\test-supervisor.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\skills\dsh-maintenance\tests\test-rotacao.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\skills\dsh-maintenance\tests\test-install.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\skills\dsh-maintenance\tests\test-hung.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\skills\dsh-maintenance\tests\test-parse.ps1
```

- **Captura de assassino (sintética, sem tocar no DSH)**: processo descartável
  morto por um processo externo cujo commandline cita o PID; `processos.jsonl` +
  `veredito-*.json` mostram `killed` com PID/PPID/commandline/ancestrais.
  `-Killer taskkill` faz o mesmo com `taskkill /F` em um shell normal.
- **Supervisor**: processo descartável supervisionado, morto, com `ExitCode` e
  instante no log com timestamp.
- **Rotação/retenção**: mais de um dia simulado (`-ForceDate`) gerando arquivos de
  dias diferentes e descartando os antigos.
- **Instalador idempotente**: `install.ps1` rodado 2× sem duplicar Startup nem
  processos; `uninstall.ps1` remove Startup e mantém os dados.
- **Hung**: porta aberta sem resposta HTTP por > 20 s gera `hung` com confiança alta.
- **Durabilidade do JSONL**: `test-captura-killer` lê `processos-*.jsonl` com o
  observador ainda **vivo** e mostra a última linha; falha se o arquivo estiver
  vazio (regressão do buffer de 4 KB do `FileStream`, que já aconteceu de fato).
- **Heartbeat e latência de morte**: o mesmo teste imprime `morte->veredito_s` e
  exige ≤ 5 s entre o kill e o registro; o heartbeat é esperado com
  `-TimeoutSec 60` (default derivado da medição de inicialização).
- **Parse**: todos os `.ps1` no analisador do PowerShell + frontmatter do
  `SKILL.md` válido + `.ps1` em ASCII puro (PS 5.1 sem BOM lê como ANSI).

Trechos reais de cada teste em [`TESTES.md`](../../docs/dsh-maintenance/TESTES.md).

## Limites conhecidos (honestidade)

- **Sem admin não há** auditoria de processo (Security 4688 / canal Security),
  eventos WMI de processo (`Win32_ProcessStartTrace`), ETW, Sysmon, driver ou
  filtro de kernel. Nada disso é instalado nem seria instalável sem elevação.
- A `CommandLine` e o `PPID` vêm do **PEB** (`NtQueryInformationProcess` +
  `ReadProcessMemory`, mesmo usuário, sem admin). O fallback WMI existe na
  `lib.ps1` (`$script:UseWmiFallback = $true`) mas **não** é usado por padrão:
  carregar os módulos CIM custa dezenas de MB e no sandbox do agente o WMI é
  negado. Em processo de outro usuário/elevado a leitura do PEB falha — nesse
  caso o campo pode vir vazio e o veredito cai para `unknown` com confiança menor.
- **Baseline do primeiro ciclo:** processos que já existiam quando o observador
  iniciou entram só na contagem (`{"event":"baseline"}`, sem `start`/`cmdline`).
  Um assassino que já estivesse vivo antes do observador não terá registro de
  `start`; a morte do alvo continua no `snapshot`/veredito.
- **Polling de 100 ms não é gancho do kernel.** Processo que nasce e morre em
  menos de 100 ms pode não aparecer em `processos.jsonl`; a janela entre duas
  amostras é um ponto cego. Nesta máquina um `taskkill /F` bem-sucedido fica
  visível por ~117–165 ms (8 medições em `TESTES.md` §1c), mas um `taskkill` que
  falha sai em < 50 ms.
- Um `taskkill`/`Stop-Process` que **saiu com o alvo ainda vivo** não é citado
  como assassino (campo `alvo_vivo_no_fim` no registro de saída).
- `snapshot` de 2 s pode perder uma morte seguida de subida imediata (troca de
  PID é detectada, mas o instante exato vem do supervisor).
- Sessões: só `mtime`, tamanho e hash parcial — **não** há leitura do conteúdo
  (zstd) e nenhuma captura de mensagens.
- O observador **não reinicia o DSH** e **não** interfere nele; se a máquina
  desligar, ele volta no próximo logon (Startup).
- Se o próprio observador morrer, há um buraco até o `supervisor-observador.ps1`
  reerguê-lo; esse buraco é registrado em `lacunas-*.jsonl`, não apagado.
- Uma conclusão que dependa de 4688/ETW só sai com sessão elevada — até lá o
  veredito correto é `unknown`, dito com todas as letras.

## Ver também

- [SKILL.md](SKILL.md) — diagnóstico, recuperação e checklist de manutenção.
- [TESTES.md](../../docs/dsh-maintenance/TESTES.md) — evidência dos testes obrigatórios.
- [RETROSPEC-2026-11-11](../../docs/dsh-maintenance/RETROSPEC-2026-11-11.md) — reconstrução das quedas do dia.
- `F:\ai\_lab\dsh-saude\watchdog-3080.ps1` — vigia da porta 3080 (sobe, nunca mata).
- `F:\ai\_lab\dsh-saude\garantir-e-abrir.ps1` e `abrir-dsh.cmd` — o que o atalho
  “DSH - Abrir (3080)” executa.
- `F:\ai\_lab\boot\dsh-diario.ps1` — boot do DSH diário.
- `C:\Users\carlos\.dsh\sessions\` — sessões (zstd) usadas no hash.
