---
name: dsh-maintenance
description: "Use quando o DSH diário (Web UI em http://127.0.0.1:3080) cair, travar, ficar sem resposta ou for encerrado de forma suspeita, e para manutenção preventiva lendo o observador — gatilhos: DSH caiu, 3080 sem resposta, observador, manutenção, reinício, taskkill, sessão perdida."
---

# DSH manutenção — diagnosticar a queda sem derrubar nada

O DSH diário roda em `http://127.0.0.1:3080` (perfil `web`) e já foi **encerrado
8 vezes em um dia** (2026-11-11, ver
[RETROSPEC-2026-11-11](../../docs/dsh-maintenance/RETROSPEC-2026-11-11.md)).
A causa de uma dessas quedas (~18:14) continua **desconhecida**. Esta skill existe
para (a) não piorar nada, (b) ler a evidência que já está no disco e (c) dizer com
honestidade o que é provado, provável ou indeterminado.

Formato técnico dos artefatos: [README desta skill](README.md).

## 1. Regra de ouro — nunca matar o DSH

**Proibido**, em qualquer sessão e por qualquer motivo:

- `taskkill` (com `/F`, `/T`, por PID ou por nome) contra o `node.exe` do DSH;
- `Stop-Process` contra o PID que está **LISTEN** na porta 3080 (ou contra qualquer
  processo pai/dele);
- rodar `restart-dsh.ps1` (está renomeado para `.DESATIVADO`), a tarefa
  `repo-watcher-restart`, ou "reiniciar o DSH para ver se resolve";
- `Stop-Process`/`taskkill` em `powershell.exe` alheio, no vigia ou no observador.

**Por quê:** o agente roda *dentro* do DSH. Matar o processo é auto-sabotagem: a
própria conversa morre, o trabalho em andamento é perdido e a evidência da queda
(o stack/ExitCode) desaparece junto. Foi exatamente isso que o `restart-dsh.ps1`
fez 7 vezes — e em uma delas o DSH ficou **~56 min fora do ar**.

Quem sobe servidor morto é **um único** componente:
`F:\ai\_lab\dsh-saude\watchdog-3080.ps1`. Ele verifica a porta a cada **20 s**,
**nunca mata nada**, e se a porta estiver morta chama
`F:\ai\_lab\boot\dsh-diario.ps1` e espera até **180 s** por HTTP 200/401.
O observador **não reinicia** o DSH — só grava.

Se a tentação for "reiniciar para limpar estado": **não**. Primeiro leia os
artefatos (seção 2), classifique (seção 3) e só então decida com o usuário.

## 2. Ler os artefatos do observador e montar a linha do tempo

Raiz dos dados (instalação padrão, fora da árvore do DSH):

```powershell
$obs = 'F:\ai\_lab\dsh-saude\observador\observacao'
$logs = 'F:\ai\_lab\dsh-saude\observador\logs'
```

Ordem de leitura — sempre nesta sequência, do mais barato ao mais caro:

1. **Heartbeat do observador** (5 s). Se estiver velho, a lacuna é do observador,
   não do DSH:

   ```powershell
   $e = Get-Content "$obs\estado.json" -Raw | ConvertFrom-Json
   $e | Select-Object pid, iniciado, ultimo_ciclo, ciclos, erros, alvo_pid, porta
   (New-TimeSpan -Start ([datetime]$e.ultimo_ciclo) -End (Get-Date)).TotalSeconds
   ```

   `> 15 s` = observador atrasado (investigar); `> 45 s` = o
   `supervisor-observador.ps1` já deve ter registrado `lacunas-*.jsonl` e
   reerguido o observador (default `-HeartbeatMaxSec 45`).

2. **Último veredito** (é o resumo pronto da queda):

   ```powershell
   $v = Get-ChildItem "$obs\veredito-*.json" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
   $v | Select-Object Name, LastWriteTime
   Get-Content $v.FullName -Raw | ConvertFrom-Json | Format-List
   ```

3. **Processos no intervalo da queda** (poll de 100 ms; é aqui que aparece o
   assassino, se ele existiu):

   ```powershell
   $p = "$obs\processos-2026-11-11.jsonl"
   Select-String -Path $p -Pattern 'taskkill|Stop-Process|3080' | Select-Object LineNumber, Line
   ```

   A primeira linha do dia pode ser `{"event":"baseline","count":N,...}`: é só a
   contagem do boot (PIDs/PPIDs pela API nativa, sem dump de todos os processos).
   Processos que já existiam antes do observador não têm registro de `start`; a
   morte do alvo aparece no `snapshot`/`estado.json` e no veredito.

4. **Snapshots** em volta do instante (2 s cada): PID vivo/morto, HTTP, conexões.

5. **Eventos** (30 s): Kernel-Power, WER/AppCrash, erros de serviço, TaskScheduler.

6. **Sessões** (30 s, só mtime/tamanho/hash): a última gravação antes da queda dá
   o instante aproximado do fim da conversa.

7. **Console do supervisor**, se o DSH foi iniciado por ele:
   `$logs\dsh-console-timestamped.log` (stdout+stderr com timestamp) e
   `$logs\supervisor-AAAA-MM-DD.jsonl` (ExitCode + instante).

Montagem da linha do tempo (filtra uma janela e mistura as 3 fontes):

```powershell
$ini = [datetime]'2026-11-11T18:10:00'; $fim = [datetime]'2026-11-11T18:35:00'
$linhas = @()
foreach ($f in 'snapshot','processos','eventos') {
  Get-Content (Join-Path $obs ("{0}-2026-11-11.jsonl" -f $f)) | ForEach-Object {
    $o = $_ | ConvertFrom-Json
    $t = [datetime]$o.ts
    if ($t -ge $ini -and $t -le $fim) { $linhas += [pscustomobject]@{ ts = $t; fonte = $f; o = $o } }
  }
}
$linhas | Sort-Object ts | ForEach-Object {
  $o = $_.o
  switch ($_.fonte) {
    'snapshot'  { '{0:HH:mm:ss} snap http={1}/{2}ms pid={3} alive={4} est={5}' -f $_.ts,$o.http.code,$o.http.ms,$o.target.pid,$o.target.alive,$o.conn.ESTABLISHED }
    'processos' { '{0:HH:mm:ss} proc {1} {2} pid={3} ppid={4} suspect={5} | {6}' -f $_.ts,$o.event,$o.name,$o.pid,$o.ppid,$o.suspect,$o.cmdline }
    'eventos'   { '{0:HH:mm:ss} evt {1}/{2} {3}' -f $_.ts,$o.log,$o.id,$o.message }
  }
}
```

Também vale ler o que já existia antes do observador:
`F:\ai\_lab\superagent-nativo\restart.log`,
`F:\ai\_lab\boot\logs\dsh-diario-boot.log` e as sessões em
`C:\Users\carlos\.dsh\sessions\*\*\session.v4.jsonl.zstd` (descompressão:
`F:\ai\_lab\superagent-nativo\_decompress.mts` via `pnpm exec tsx`).

## 3. Classificar a queda e citar a evidência

Quatro classificações, cada uma com o que a sustenta:

| Veredito | O que prova | Confiança alta quando… |
|---|---|---|
| `killed` | alguém encerrou o DSH de fora | há `processos.jsonl` com `taskkill` / `powershell` cujo `cmdline` cita o PID do DSH e `cmdline`/`ppid`/`ancestors[]` legíveis (o código pontua: score ≥12 = alta, ≥8 = média) |
| `crashed` | o processo morreu sozinho (erro) | `ExitCode != 0` no supervisor **com** stack/erro no `dsh-console-timestamped.log`, ou WER/AppCrash em `eventos.jsonl` |
| `hung` | continuou vivo mas parou de responder | porta 3080 em LISTEN **e** `http.code` = `000` (timeout do probe de 4 s) por > 20 s em `snapshot.jsonl` |
| `unknown` | dados insuficientes | só se usa quando nada acima se sustenta — e isso **tem** de ser dito, não maquiado |

Confiança: `alta` = evidência direta (linha do JSONL + PID casando); `media` =
indício forte sem prova direta (ex.: sessão parou às 18:13:23, sem registro de
processo); `baixa` = só sintoma (sumiu do snapshot sem causa).

**Toda conclusão precisa citar arquivo + linha + horário.** Exemplo de citação
aceitável num report:

```
morto por restart-dsh.ps1 — evidência real, arquivo + linha + horário:
F:\ai\_lab\superagent-nativo\restart.log:66 (2026-11-11 16:49:23) "encerrando DSH (PID 5660)"

o mesmo evento no formato que o observador gravaria (esse arquivo só existe depois do install):
observador\observacao\processos-2026-11-11.jsonl:1412 (2026-11-11T16:49:23-03:00)
  {"event":"start","pid":8844,"ppid":6120,"name":"taskkill.exe","cmdline":"taskkill /PID 5660 /T /F","target_pid":5660}
```

Regras de honestidade ao classificar:

- **Não** diga "caiu por X" se X é inferido de contexto; diga "provável X" e mostre
  o que falta para provar.
- A queda das ~18:14 de 2026-11-11 **continua indeterminada** (nenhum registro de
  processo, nenhum evento WER/Kernel-Power). O observador novo é o que permitiria
  fechar esse caso; se nem ele registrou, aceite `unknown` com confiança `baixa`.
- `HTTP 401` é **normal** (a UI pede auth). 401 rápido (~ms) = servidor vivo.
- Um `veredito-*.json` que diz `killed` sem `assassino` preenchido é contraditório:
  rebaixe a confiança e diga isso.

## 4. Recuperação sem terminal (o que dizer ao usuário)

O usuário não precisa de terminal, PowerShell nem admin. Roteiro, nesta ordem:

1. **F5** na aba do `http://127.0.0.1:3080/`. Se a página estava só desconectada,
   isso resolve — o servidor segue no ar.
2. Se a página não carregar: clicar duas vezes no atalho **“DSH - Abrir (3080)”** no
   Desktop. Ele roda `F:\ai\_lab\dsh-saude\abrir-dsh.cmd` →
   `garantir-e-abrir.ps1`: se a porta responder (HTTP 200/401), só abre o navegador;
   se estiver morta, chama `dsh-diario.ps1` e espera até 180 s.
3. Se ainda assim não abrir: **não fazer nada destrutivo**. O vigia
   `watchdog-3080.ps1` já checa a porta a cada 20 s e sobe o DSH sozinho
   (uma instância só, mutex `Global\DSH-Watchdog-3080`). Espere ~3 min e tente o
   atalho de novo.
4. Confirmar sem terminal, pela resposta do atalho: se abrir a UI, está no ar.
   Do lado do agente: `curl.exe -s -o NUL -w '%{http_code}' --max-time 6 http://127.0.0.1:3080/`
   → `200` ou `401` = ok; `000` = fora do ar.

O que **não** dizer ao usuário: "mata o node", "roda o restart", "reinicia o PC",
"abre o gerenciador de tarefas e encerra o node". Nada disso é necessário: o
`restart-dsh.ps1` foi quem causou **7 das 8** quedas registradas no dia.

Durante a recuperação, o agente **não** deve disparar `taskkill` para "ajudar".
Se a conversa atual morrer junto com o DSH, o veredito e o log com timestamp do
supervisor são o que sobram — por isso eles existem.

**ExitCode em produção:** só existe se o DSH foi iniciado pelo
`supervisor-dsh.ps1`. O boot diário atual (`dsh-diario.ps1` → `iniciar-web.bat`)
não passa por ele; o README (seção "Install") tem o passo manual para trocar o
launcher. Sem esse passo, o observador ainda classifica
`killed`/`hung`/`unknown` e diz nas `limitacoes[]` que não houve supervisor.

## 5. Checklist de manutenção (read-only, ~30 s)

Rodar antes de qualquer mudança e depois de qualquer queda. **Nada aqui encerra
processo.** O bloco abaixo dot-sourceia a `lib.ps1` do observador; se o shell
bloquear script não assinado (`PSSecurityException`), rode o bloco via
`powershell -NoProfile -ExecutionPolicy Bypass -Command "..."`.

```powershell
# lib do observador instalado (funcoes sem admin que funcionam mesmo em sandbox)
. 'F:\ai\_lab\dsh-saude\observador\scripts\lib.ps1'

# 1. porta 3080: codigo e latencia
curl.exe -s -o NUL -w '%{http_code} %{time_total}s' --max-time 6 http://127.0.0.1:3080/

# 2. quem detem a porta (netstat; Get-NetTCPConnection exige privilegio em sandbox)
$pi = Get-PortInfo 3080
[pscustomobject]@{ listen = $pi.listen; dono_pid = $pi.owner_pid; estados = $pi.states } |
  Format-List

# 3. processo do DSH: PEB direto quando o sandbox permite; senao use o snapshot
#    do observador (que roda fora do sandbox e enxerga o DSH)
$d = Get-PebInfo $pi.owner_pid
if ($d.ok) {
  [pscustomobject]@{ pid = $pi.owner_pid; ppid = $d.ppid; cmdline = $d.cmdline } | Format-List
} else {
  $hoje = (Get-Date).ToString('yyyy-MM-dd')
  Get-Content "F:\ai\_lab\dsh-saude\observador\observacao\snapshot-$hoje.jsonl" -Tail 1
}

# 3b. vigia da porta 3080 (sobe servidor morto, nunca mata) — prova indireta:
#     o vigia roda fora do sandbox; confira o log e o autostart
Get-Content 'F:\ai\_lab\dsh-saude\watchdog.log' -Tail 3
Get-ChildItem "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup" -Filter 'DSH - vigia*'

# 4. observador no ar + heartbeat recente (fonte: estado.json)
$e = Get-Content 'F:\ai\_lab\dsh-saude\observador\observacao\estado.json' -Raw | ConvertFrom-Json
[pscustomobject]@{ pid=$e.pid; ciclos=$e.ciclos; erros=$e.erros; alvo_pid=$e.alvo_pid; atraso_s=[int](New-TimeSpan -Start ([datetime]$e.ultimo_ciclo) -End (Get-Date)).TotalSeconds }

# 5. supervisor do observador: prova indireta (processo roda fora do sandbox e nao
#    e visivel ao agente); confira Startup + lacunas
Get-ChildItem "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup" -Filter 'DSH*'
$hoje = (Get-Date).ToString('yyyy-MM-dd')
Get-Content "F:\ai\_lab\dsh-saude\observador\observacao\lacunas-$hoje.jsonl" -Tail 5

# 6. tarefa de restart deve estar Disabled (ou ausente — aqui ela não existe mais)
schtasks /Query /TN 'repo-watcher-restart' /FO LIST   # Ready/Running = regressão: reportar, não habilitar

# 7. ACL dos workspaces do watcher (precisa de escrita do usuário)
Get-Acl 'F:\ai\_lab\superagent-nativo\watcher\work' | Format-List
Get-ChildItem 'F:\ai\_lab\superagent-nativo\watcher\work' -Directory | Select-Object Name, LastWriteTime
```

> **Limite do sandbox:** o agente roda em um job restrito e **não enxerga** os
> processos de fora dele (`Get-Process`/`Get-CimInstance` podem negar o PID do
> DSH). Por isso a fonte primária de verdade sobre o DSH é o **observador**, que
> roda no logon do usuário, fora desse job.

| Item | Saudável | Se não estiver |
|---|---|---|
| porta 3080 | HTTP `200`/`401` em poucos ms | espere o vigia (20–180 s); se persistir, ver seção 3 |
| node do DSH | 1 processo LISTEN, `StartTime` recente, CPU baixa | não mate; classifique a queda |
| vigia | exatamente 1 `watchdog-3080.ps1` | relançar `F:\ai\_lab\dsh-saude\iniciar-vigia.cmd` (não mata nada) |
| observador | `estado.json` com atraso ≤ 15 s, `ciclos` crescendo | > 45 s: ver `lacunas-*.jsonl`; relançar via `supervisor-observador.ps1`/Startup |
| restart | tarefa Disabled/ausente, `restart-dsh.ps1.DESATIVADO` presente | **não** reative |
| workspaces `watcher\work\<ticket>` | graváveis pelo usuário | se falhar `SetNamedSecurityInfoW failed (Win32 5)`: reportar `blocked` com o erro exato |
| disco | datas só dos últimos 7 dias; sem arquivo gigante | rotação/retenção do observador |

## 6. Limites: o que exige admin e como reportar sem inventar

Sem sessão elevada **não** existe:

- auditoria de processo do Windows (Security 4688) e canal Security do Event Log;
- eventos WMI de criação/encerramento de processo (`Win32_ProcessStartTrace`) e ETW;
- Sysmon/driver/filtro de kernel (nem instalado, nem instalável sem admin).

O observador cobre a lacuna com um snapshot de PIDs/PPIDs via
`NtQuerySystemInformation` a cada **100 ms** + leitura do PEB via
`NtQueryInformationProcess`/`ReadProcessMemory` para `CommandLine` e `PPID`
(mesmo usuário, sem admin), com fallback WMI quando disponível. Consequência
honesta: **processo que nasce e morre em menos de 100 ms pode escapar**; e, se o
assassino rodou elevado, ele ainda aparece na lista (nome/PID), mas `cmdline` e
`ppid` podem vir vazios por falha de leitura do PEB.

Como reportar quando a evidência não fecha:

1. Estado = `blocked` (ou `waiting`, se faltar dado externo), **nunca** `ready` com
   conclusão inventada.
2. Separe explicitamente **provado** (linha de arquivo), **provável** (indício +
   raciocínio) e **indeterminado** (o que falta).
3. Diga o que resolveria: sessão elevada, auditoria 4688, Sysmon, ou captura do
   supervisor com `ExitCode`.
4. Nunca cite número que não foi medido — se não mediu CPU/RAM, escreva "não
   medido".

## Ver também

- [README desta skill](README.md) — formato dos JSONL, vereditos, custo, install/uninstall.
- [TESTES.md](../../docs/dsh-maintenance/TESTES.md) — evidência dos testes obrigatórios.
- [RETROSPEC-2026-11-11](../../docs/dsh-maintenance/RETROSPEC-2026-11-11.md) — as 3 quedas do dia reconstruídas.
- `F:\ai\_lab\dsh-saude\watchdog-3080.ps1` — o vigia que sobe e nunca mata.
- `F:\ai\_lab\dsh-saude\garantir-e-abrir.ps1` — o que o atalho do Desktop executa.
