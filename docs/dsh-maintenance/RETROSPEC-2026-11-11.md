# RETROSPEC 2026-11-11 — as quedas do DSH diário (porta 3080)

> Reconstrução feita a partir dos logs que já existiam na máquina **antes** do
> observador `dsh-maintenance`. O objetivo é separar o que está **provado**, o
> que é **provável** e o que é **indeterminado** — sem maquiar a queda das ~18:14.
>
> Fontes primárias: `F:\ai\_lab\superagent-nativo\restart.log`,
> `F:\ai\_lab\boot\logs\dsh-diario-boot.log`,
> `F:\ai\_lab\superagent-nativo\dsh-console.log`,
> `F:\ai\_lab\dsh-saude\watchdog.log`,
> `F:\ai\_lab\dsh-saude\DIAGNOSTICO-TRAVAMENTO-2026-11-11.md`,
> sessões em `C:\Users\carlos\.dsh\sessions\*\*\session.v4.jsonl.zstd`.
>
> Data da análise: 2026-11-11, após 19:00 (America/Sao_Paulo). Nenhum processo foi
> encerrado ou reiniciado para escrever este documento.

## 1. Resumo honesto

| # | Janela | O que aconteceu | Classificação | Confiança |
|---|---|---|---|---|
| 1 | 12:17:01 → 13:40:00 | 7 ciclos completos de `restart-dsh.ps1` mataram e resubiram o DSH | **killed** por `restart-dsh.ps1` | alta (log do próprio script + boot log) |
| 2 | 16:48:38 → 17:45:33 | 8º ciclo do `restart-dsh.ps1` matou o DSH (PID 5660) e **o script morreu sem terminar o log**; DSH ficou **~56 min fora do ar** | **killed** por `restart-dsh.ps1` | alta para o assassino; média para "por que o script morreu" |
| 3 | 18:13:23 → 18:29:37 | instância de 17:45 parou de responder/sumiu; **nenhum** registro de autor; usuário abriu `iniciar-web.bat` às 18:29:37 | **unknown** (dados insuficientes) | baixa — e continua indeterminada |

Contagem: o `restart.log` registra **8 execuções** do script (7 completas no
meio-dia + 1 truncada às 16:48). A morte de ~18:14 é a **9ª** instância encerrada
do dia, mas a única sem autor. A issue fala em "8 vezes"; a diferença vem de
contar o ciclo truncado de 16:48 e a queda desconhecida de formas diferentes.
O fato bruto é: **8 kills documentados no `restart.log` + 1 kill sem autor.**

## 2. Linha do tempo consolidada (hora local)

| Hora | Evento | Evidência |
|---|---|---|
| 12:17:01 | `restart-dsh.ps1` inicia (delay 45 s) | `restart.log:1` |
| 12:17:46 | `taskkill` no DSH PID 18872 + 7 filhos, porta liberada | `restart.log:2-12` |
| 12:18:07 | `dsh-diario.ps1` sobe de novo; HTTP 401 | `restart.log:13-16`, `dsh-diario-boot.log:9-11` |
| 12:47:00–12:48:00 | ciclo 2 (PID 23724) | `restart.log:17-24`, boot log:12-14 |
| 12:52:00–12:53:00 | ciclo 3 (PID 9656) | `restart.log:25-32`, boot log:15-17 |
| 13:09:00–13:10:01 | ciclo 4 (PID 25156) | `restart.log:33-40`, boot log:18-20 |
| 13:19:01–13:20:01 | ciclo 5 (PID 27236) | `restart.log:41-48`, boot log:21-23 |
| 13:30:01–13:31:01 | ciclo 6 (PID 29124) | `restart.log:49-56`, boot log:24-26 |
| 13:39:00–13:40:00 | ciclo 7 (PID 5724) | `restart.log:57-64`, boot log:27-29 |
| 16:48:38 | ciclo 8 inicia (delay 45 s) | `restart.log:65` |
| 16:49:23 | `taskkill` no DSH PID 5660; **última linha do log** | `restart.log:66` |
| 16:49 → 17:45 | DSH fora do ar (~56 min) | boot log seguinte só em 17:45:19; sessões sem gravação |
| 17:45:19–17:45:33 | boot script sobe o DSH; HTTP 401 | `dsh-diario-boot.log:30-32` |
| 18:13:23 | último evento da sessão do usuário (turno 19 termina) | `DIAGNOSTICO-TRAVAMENTO-2026-11-11.md` §2; sessão `8d79a9ed…` |
| 18:14–18:29 | **sem registro de processo, evento WER/Kernel-Power ou tarefa** | consultas ao Event Log (ver §5) |
| 18:29:37 | usuário abre `iniciar-web.bat` pelo Explorer | `DIAGNOSTICO-TRAVAMENTO-2026-11-11.md` §2 |
| 18:30:16 | servidor novo fecha a sessão órfã (`session/end-seed`) | `DIAGNOSTICO-TRAVAMENTO-2026-11-11.md` §2; mtime da sessão `8d79a9ed…` |
| 18:39:07 | vigia `watchdog-3080.ps1` inicia (PID 26904) | `watchdog.log` (única linha) |

## 3. Queda 1 — os 7 ciclos do meio-dia (12:17–13:40)

### Provado

O `restart.log` é o log do próprio assassino e registra, ciclo a ciclo:

```
2026-11-11 12:17:46 encerrando DSH (PID 18872)
2026-11-11 12:17:46 ÊXITO: o processo com PID 18872 (processo filho de PID 18852) foi finalizado.
2026-11-11 12:17:47 porta 3080 liberada
2026-11-11 12:17:47 chamando dsh-diario.ps1
2026-11-11 12:18:07 HTTP apos restart: 401
... (repete em 12:47, 12:52, 13:09, 13:19, 13:30, 13:39)
```

- `F:\ai\_lab\superagent-nativo\restart.log:2` (12:17:46) — "encerrando DSH (PID 18872)".
- `restart.log:18-19`, `26-27`, `34-35`, `42-43`, `50-51`, `58-59` — os mesmos
  "encerrando DSH (PID …)" e "ÊXITO" nos outros 6 ciclos.
- `F:\ai\_lab\boot\logs\dsh-diario-boot.log:9-29` — 7 boots correspondentes
  (12:17, 12:47, 12:52, 13:09, 13:19, 13:30, 13:39), todos terminando em HTTP 401.
- `dsh-console.log` contém 3 assinaturas `[ELIFECYCLE] Command failed with exit code 1.`
  — o `pnpm` pai sobrevive ao filho `node` morto e reporta falha. Não há stack,
  não há WER: **o processo foi encerrado, não quebrou.**
- O script usava `Get-NetTCPConnection -LocalPort 3080 -State Listen` +
  `taskkill /PID <dono> /T /F` (código preservado em
  `restart-dsh.ps1.DESATIVADO`).

### Conclusão

`killed` por `restart-dsh.ps1`, confiança **alta**. Não é inferência: é o log do
próprio script dizendo qual PID encerrou e quando. Cada ciclo derrubou a conversa
do usuário; a reconexão do cliente levou de segundos a ~1 min.

### O que ficou sem resposta

Por que o script rodou 7 vezes no meio-dia. A tarefa agendada
`repo-watcher-restart` (que o disparava) foi desativada depois; hoje
`schtasks /Query /TN repo-watcher-restart` responde "não encontrado" neste
ambiente. O gatilho original não está registrado em log — **provável** que tenha
sido a própria tarefa agendada em `ONCE`, mas isso não está provado.

## 4. Queda 2 — 16:48:38 a 17:45:33 (56 minutos fora do ar)

### Provado

```
2026-11-11 16:48:38 === restart-dsh: inicio (delay 45s) ===
2026-11-11 16:49:23 encerrando DSH (PID 5660)
```

- `restart.log:65` (16:48:38) e `restart.log:66` (16:49:23) — o log **termina**
  na linha do `taskkill`; não há "porta liberada", "dsh-diario.ps1", "HTTP" nem
  "fim".
- O próximo boot registrado é `dsh-diario-boot.log:30-32` — **17:45:19**, ou seja,
  o DSH ficou morto **~56 minutos**.
- Sessões param de gravar: `session-42675c7f` (16:31:52) e
  `session-deefd472` (16:35:41) são as últimas antes do kill; a próxima gravação
  é `b54613f1` (17:47:26), já depois do boot.
- `dsh-console.log` (último bloco sem `[ELIFECYCLE]`) e o fato de o log do script
  morrer no meio indicam que o `taskkill /T /F` atingiu a árvore que hospedava o
  próprio script: ele não chegou a chamar o boot.

### Conclusão

`killed` por `restart-dsh.ps1`, confiança **alta** para o assassino (PID 5660
citado na linha 66). A causa de o script ter morrido junto é **provável**
(taskkill na própria árvore), não provada: não há log de como o script foi
iniciado nem de quem o hospedava.

## 5. Queda 3 — ~18:13:23 a 18:29:37 (autor desconhecido)

### O que está provado

- A sessão do usuário (`session-8d79a9ed…`, workspace `--F-ai--`) registra o fim
  do turno 19 às **18:13:23** (fato documentado no
  `DIAGNOSTICO-TRAVAMENTO-2026-11-11.md`; mtime atual do arquivo é 18:30:16,
  quando o servidor novo fechou a sessão órfã com `session/end-seed`).
- **Não há** linha no `restart.log` entre 16:49:23 e o fim do dia.
- **Não há** boot em `dsh-diario-boot.log` entre 17:45:33 e o fim do dia — logo o
  DSH **não** foi ressubido pelo `dsh-diario.ps1` nesse intervalo.
- O usuário abriu `iniciar-web.bat` pelo Explorer às **18:29:37**; o servidor
  atual (PID 29072) começou em 18:29:40 e responde 401 em ~1–4 ms.
- Consultas ao Event Log em 2026-11-11 11:00–19:00:
  - `System` IDs 41, 1074, 6005, 6006, 6008, 7030, 7031, 7034 → **nenhum evento**;
  - `Application` IDs 1000, 1001, 1002, 1026 (WER/AppCrash) → **nenhum evento**;
  - `Microsoft-Windows-TaskScheduler/Operational` → log **vazio** (nenhum evento).
  - `Security` (4688/4689) → **acesso negado** sem admin.

### Conclusão

**Indeterminado.** Não há evidência que permita atribuir autoria: nenhum registro
de processo, nenhum evento de crash/shutdown, nenhuma execução de tarefa. O
`dsh-console.log` não tem timestamp por linha e foi recriado às 13:19:49
(`CreationTime`), então não serve para datar o fim. As hipóteses "taskkill avulso
de outra ferramenta/agente" e "encerramento manual" são **prováveis**, não
provadas — e o próprio diagnóstico do dia já dizia isso.

O que **não** foi a causa (provado): sobrecarga, falta de memória, disco, crash
do Node/WER, erro de rede/modelo — ver `DIAGNOSTICO-TRAVAMENTO-2026-11-11.md` §3.

## 6. O que o observador `dsh-maintenance` faria diferente

| Momento | O que faltou | O que o observador gravaria |
|---|---|---|
| 12:17–13:39 | só o log do assassino; nenhum commandline do `taskkill`, nenhum pai | `processos.jsonl` com `taskkill.exe`, `cmdline` (`taskkill /PID 18872 /T /F`), `ppid` e `ancestors[]`; veredito `killed` **alta** em < 1 s |
| 16:49 | instante exato da morte e ExitCode do node | `snapshot` de 2 s mostra `alive:true → false`; `supervisor-*.jsonl` registra `exit_code` e instante com milissegundos; veredito `killed` citando a linha do `taskkill` |
| 18:14 | **tudo**: autor, processo, exit code, instante | `snapshot` de 2 s + `processos` de 100 ms capturariam o `taskkill`/`Stop-Process` se ele viveu ≥ 100 ms (um `taskkill` fica visível ~140 ms nesta máquina, medido no teste); `eventos.jsonl` confirmaria ausência de WER/Kernel-Power; veredito `killed` com `cmdline`/`ppid`, ou `unknown` **baixa** se o assassino rodou elevado e o PEB negou leitura (nesse caso o nome/PID ainda aparecem) |

Limite honesto do observador novo: sem admin não há 4688/ETW/Sysmon. Processo que
nasce e morre em menos de 100 ms ainda pode escapar; assassino elevado pode
aparecer sem `cmdline`/`ppid`. Para a queda das 18:14, o observador **aumentaria
muito** a chance de fechar o caso, mas não a garante.

## 7. Limitações desta reconstrução

- `dsh-console.log` não tem timestamp por linha, tem apenas 5 blocos de start e
  3 `[ELIFECYCLE]`; foi recriado às 13:19:49 (`CreationTime`), então a
  correspondência bloco ↔ hora é **provável**, não provada. Usei o boot log como
  fonte primária de horário.
- `restart.log` documenta o que o script fez, não quem o disparou; a tarefa
  agendada não existe mais para consulta.
- As sessões são zstd; esta análise usou o que o diagnóstico do dia já havia
  extraído (turno 19 terminando às 18:13:23) e os mtimes dos arquivos, não uma
  decodificação nova.
- Event Log sem auditoria de processo (4688 desligada) e sem eventos de
  crash/shutdown no dia; ausência de evento não prova ausência de kill.
- Nada aqui foi medido em tempo real: é reconstrução documental.

## 8. Conclusão em uma frase

As 7 quedas do meio-dia e a de 16:49 têm autor, hora e PID no log do próprio
`restart-dsh.ps1`; a de ~18:14 **não tem** — e é exatamente para essa que o
`dsh-observador` foi construído.
