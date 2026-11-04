# Como Claude e ChatGPT conduzem o Blender — pesquisa para o Blender Director v2

**Data da pesquisa:** 2026-11-04
**Escopo:** fase 1 do Blender Director v2 — entender como assistentes comerciais chegam ao Blender, o loop real de iteração, custos, limites e riscos, e o que faz sentido copiar (ou não) para o nosso pipeline.
**Método:** leitura de documentação primária de Anthropic, OpenAI e Model Context Protocol (MCP), do repositório do MCP de Blender mais usado, e de referências técnicas de métricas de imagem. Todos os links foram conferidos por HTTP em 2026-11-04; o que não foi possível executar/validar está declarado na seção 10.

> **Resumo em uma frase:** o Claude e o ChatGPT não "abrem o Blender" sozinhos. Eles emitem **chamadas de ferramenta** (function calling / tool use); um aplicativo cliente executa a ferramenta (um addon/socket no Blender, por exemplo) e devolve **texto, logs e imagens**; o modelo olha o resultado, corrige e repete. O que muda entre os produtos é o transporte (MCP, conectores, ferramentas embutidas, Canvas), não o princípio.

## Sumário

1. [Resumo executivo](#1-resumo-executivo)
2. [Como o Claude chega ao Blender](#2-como-o-claude-chega-ao-blender)
3. [Como o ChatGPT/OpenAI faz o equivalente](#3-como-o-chatgptopenai-faz-o-equivalente)
4. [O loop real: intenção → plano → comando → render → crítica → correção](#4-o-loop-real-intenção--plano--comando--render--crítica--correção)
5. [O que é específico de cada um e o que é padrão da indústria](#5-o-que-é-específico-de-cada-um-e-o-que-é-padrão-da-indústria)
6. [Comparação honesta com o nosso Blender Director](#6-comparação-honesta-com-o-nosso-blender-director)
7. [Custos, latência e limites](#7-custos-latência-e-limites)
8. [Riscos, inclusive executar `bpy` arbitrário](#8-riscos-inclusive-executar-bpy-arbitrário)
9. [O que a v2 deve copiar, adaptar e evitar](#9-o-que-a-v2-deve-copiar-adaptar-e-evitar)
10. [O que foi verificado e o que não foi](#10-o-que-foi-verificado-e-o-que-não-foi)
11. [Fontes](#11-fontes)

---

## 1. Resumo executivo

**Claude (Anthropic).** Não encontrei, na documentação primária consultada, um produto oficial da Anthropic chamado "Claude para Blender". O caminho documentado é genérico: o aplicativo hospedeiro (Claude Desktop, Claude Code ou um agente seu) implementa o **MCP** ou o **tool use** da API; o modelo recebe a lista de ferramentas com nome, descrição e JSON Schema; quando decide agir, devolve um bloco `tool_use`; o cliente executa e devolve `tool_result`; o loop continua enquanto `stop_reason == "tool_use"` ([2](#f2)). Para Blender, o servidor MCP mais conhecido é o [`ahujasid/blender-mcp`](https://github.com/ahujasid/blender-mcp), hoje renomeado **MCP for Blender** / pacote `mcp-for-blender`: um addon abre um socket TCP dentro do Blender (porta padrão 9876) e um servidor MCP traduz chamadas em comandos para esse addon ([27](#f27)). O modelo vê principalmente **texto** (resumo de cena, saída de código, erros) e **imagens sob demanda** (viewport, câmera, prancha multi-ângulo, frames ou um render) pela ferramenta `look` ([27](#f27)). O que quebra: código Python arbitrário (`execute_blender_code`), estado de sessão não reproduzível, versões de addon/Blender, contexto que cresce a cada screenshot e ausência de schema de cena versionado.

**ChatGPT/OpenAI.** O equivalente de "function calling" chama-se **function calling / tools**: você descreve funções por JSON Schema, o modelo devolve um `function_call`, seu código executa e devolve um `function_call_output` com `call_id` ([17](#f17)). A Responses API também oferece ferramentas embutidas — code interpreter, computer use, MCP remoto, busca — e `tool_search` para carregar esquemas sob demanda ([18](#f18)). O **Canvas** é uma superfície de edição/escrita/código do produto ChatGPT, não uma API pública para dirigir o Blender ([25](#f25), [26](#f26)). O **Code Interpreter** roda Python em um sandbox isolado da OpenAI; ele não controla o Blender da máquina do usuário ([20](#f20)). **Computer use** pode clicar numa interface, mas dentro de um ambiente controlado — não é a viewport do Blender do usuário por padrão ([21](#f21)). Para controlar o Blender local, é preciso uma ponte de terceiros (MCP/addon) ou uma ferramenta própria exposta via API/agente; não encontrei, na documentação consultada, uma forma de o produto ChatGPT web executar o Blender local sem essa ponte.

**O loop é o mesmo nos dois.** Intenção → plano → chamada de ferramenta → execução → observação (texto + imagem) → crítica → correção. O que muda é o transporte e o conjunto de ferramentas. Não encontrei número oficial de iterações "típicas" em nenhuma das documentações; a única afirmação pública útil é que operações complexas precisam ser quebradas em passos menores ([27](#f27)) e que o code interpreter pode reescrever e reexecutar código até funcionar ([20](#f20)). Qualquer número além disso é estimativa e está marcado como tal na seção 4.

**Comparação com o nosso Director.** Já temos o que os demos de MCP não têm: scene-spec JSON fechado e versionado, preview por SSE, comandos incrementais, fila, timeout e **gate de aprovação humana** (README interno do `tools/blender-director`). Falta a camada de intenção (o `planner.js` desta fase é o primeiro passo), o crítico visual real (o `critic.js` é esqueleto), a memória de cena e a integração com modelo. O que **não** vale copiar: execução de Python arbitrário como padrão, conversa como única fonte de verdade e loop sem orçamento. O que vale copiar: o contrato de ferramenta explícito, a observação por imagem e a separação rígida entre "modelo propõe" e "aplicação executa".

---

## 2. Como o Claude chega ao Blender

### 2.1 O contrato de tool use

A documentação da Anthropic descreve tool use como um contrato: você declara as operações e a forma dos dados; o modelo decide **quando** chamar; a aplicação executa. "O modelo nunca executa nada por conta própria. Ele emite uma requisição estruturada, seu código (ou os servidores da Anthropic) executa a operação, e o resultado volta para a conversa" ([2](#f2)). Há três categorias ([2](#f2)):

| Categoria | Quem executa | Exemplos | Consequência para o Blender |
| --- | --- | --- | --- |
| Ferramentas definidas pelo usuário (cliente) | Sua aplicação | `criar_objeto`, `renderizar_preview` | É o caso de um MCP/addon de Blender: o código roda na sua máquina. |
| Ferramentas com schema da Anthropic (cliente) | Sua aplicação | `bash`, `text_editor`, `computer` | `computer` pode operar a UI do Blender num ambiente controlado. |
| Ferramentas executadas no servidor | Anthropic | `web_search`, `code_execution` | Não alcançam o seu Blender local; `code_execution` é sandbox da Anthropic. |

O loop canônico é explícito ([2](#f2)):

1. envie `tools` + mensagem;
2. Claude responde com `stop_reason: "tool_use"` e um ou mais blocos `tool_use`;
3. execute cada ferramenta e formate o resultado como `tool_result`;
4. reenvie a conversa com os resultados;
5. repita enquanto `stop_reason == "tool_use"`; pare em `end_turn`, `max_tokens`, `stop_sequence` ou `refusal`.

Detalhe importante para custo/latência: **cada chamada de ferramenta é pelo menos um round trip adicional** ([2](#f2)). Em ferramentas de servidor, a Anthropic roda um loop interno e pode devolver `pause_turn` ao atingir o limite; a aplicação reenvia a conversa para continuar ([2](#f2)). Em ferramentas de cliente, o limite prático é o seu orçamento de tokens/contexto e o seu próprio loop.

### 2.2 MCP: o protocolo que padroniza a descoberta

O **Model Context Protocol** é um protocolo JSON-RPC 2.0 entre um *host* (a aplicação de IA, como Claude Desktop ou VS Code), um *cliente* por servidor e um *servidor* que expõe contexto ([9](#f9), [10](#f10)). Os componentes principais são protocolo base, ciclo de vida/capabilities, autorização para HTTP, e as features de servidor: **resources, prompts e tools** ([9](#f9)). As ferramentas são "model-controlled": o modelo descobre e invoca com base na descrição e no schema; o cliente lista com `tools/list`, e o servidor declara a capability `tools` (com `listChanged` se a lista muda) ([11](#f11)). O próprio spec recomenda human-in-the-loop: UI que mostre as ferramentas expostas, indicadores visuais quando uma ferramenta é invocada e confirmação para operações ([11](#f11)).

Há duas formas de usar MCP com Claude ([3](#f3)):

- **Cliente MCP local** (Claude Desktop/Claude Code): o host inicia o servidor por STDIO ou conecta num servidor local; é o caminho do `mcp-for-blender` na máquina do usuário.
- **MCP connector na Messages API** (beta): você passa `mcp_servers` e `mcp_toolset` e a Anthropic conecta a servidores MCP **remotos**, sem implementar um cliente MCP ([3](#f3)). Isso não resolve, sozinho, controlar um Blender atrás de um NAT: o servidor MCP precisa estar acessível (ou tunelado). A documentação de MCP tunnels existe justamente para esse tipo de acesso ([3](#f3)).

O ponto que importa para o nosso design: **MCP não é um modelo nem um renderizador**. É um contrato de descoberta e chamada. O julgamento visual e a decisão de iterar continuam no modelo; a execução e o estado continuam no servidor/addon.

### 2.3 O `mcp-for-blender` (ex-`blender-mcp`) por dentro

O README do projeto descreve dois componentes ([27](#f27)):

1. **Addon do Blender** (`addon.py`): cria um servidor de socket TCP dentro do Blender e recebe comandos.
2. **Servidor MCP** (`src/blender_mcp/server.py`): implementa MCP e conversa com o addon.

A configuração padrão é `BLENDER_HOST=localhost` e `BLENDER_PORT=9876`; o protocolo é JSON simples com `type` + `params` e resposta `status` + `result`/`message` ([27](#f27)). O README é explícito: o socket **não tem autenticação nem criptografia**, e "qualquer um que alcance essa porta pode rodar Python dentro do Blender"; a recomendação é manter em `localhost` ou túnel SSH ([27](#f27)). O `execute_blender_code` roda Python arbitrário, com aviso de "potencialmente perigoso" ([27](#f27)). Existe um modo opcional `BLENDER_MCP_SAFE_MODE=1` que inspeciona o script e bloqueia acesso a arquivos, rede, execução de programas e código persistente; scripts bloqueados voltam ao modelo com o motivo para ele tentar de novo ([27](#f27)).

As ferramentas declaradas ("nove ferramentas") incluem ([27](#f27)):

| Ferramenta | O que faz | O que o modelo recebe |
| --- | --- | --- |
| `execute_blender_code` | Roda Python na sessão aberta | Texto de saída/erro do interpretador. |
| `look` | Vê viewport, câmera, prancha de ângulos, frames ou um arquivo de render; modos solid/material/rendered/wireframe/xray | Uma imagem (ou conjunto) para "olhar". |
| `get_scene_info` | Resumo compacto da cena, uma linha por objeto, com campos selecionáveis; `root`/`query` para aprofundar | Texto estruturado. |
| `generate_3d` | Gera/importa modelo via Tripo, Hunyuan3D, Hyper3D Rodin, Meshy | Texto/objeto importado. |
| `search_assets` / `import_asset` | Poly Haven, Sketchfab, Poly Pizza | Texto + previews/asset importado. |
| `get_addon_status` | Versão do Blender/addon e bibliotecas ativas | Texto. |
| `disable_telemetry`, `record_trajectory_feedback` | Controles de dados | Texto. |

O que o modelo **realmente vê** nesse arranjo:

- a saída textual de `execute_blender_code` (incluindo tracebacks);
- o resumo textual de `get_scene_info`;
- imagens estáticas sob demanda com `look` — não um vídeo contínuo da viewport;
- nomes/descrições de ferramentas e resultados de assets;
- **não vê** automaticamente o grafo de shaders, a topologia interna, as propriedades de todos os objetos, nem o histórico completo de undo. Se precisar, tem que pedir via código ou `get_scene_info`.

O README também reconhece a limitação de granularidade: "operações complexas podem precisar ser quebradas em passos menores" ([27](#f27)). Isso é a descrição mais próxima de "quantas iterações" que encontrei em fonte primária — e é qualitativa.

**Onde quebra na prática** (síntese das fontes, não medição):

| Ponto | Sintoma | Por quê |
| --- | --- | --- |
| Código arbitrário | `NameError`, API que mudou, contexto de operador inválido | O modelo escreve Python contra uma API grande; o erro só aparece no `tool_result` ([27](#f27)). |
| Estado de sessão | Repetir o pedido não reproduz a cena; undo/redo imprevisível | A verdade é o histórico da conversa + estado do `.blend`, não um spec versionado ([27](#f27)). |
| Socket/versão | "não conecta", timeout, addon desatualizado | Addon e servidor MCP precisam casar; porta/host configuráveis ([27](#f27)). |
| Contexto | Muitas imagens e outputs estouram orçamento | Cada screenshot é imagem; imagens contam tokens ([4](#f4), [6](#f6)). |
| Percepção | "Parece certo" mas proporção/cor erradas | Uma imagem de viewport em baixa resolução não mostra tudo; `look` é sob demanda. |
| Segurança | Prompt injection / código malicioso apaga ou vaza dados | `execute_blender_code` sem sandbox por padrão; safe mode é opt-in ([27](#f27)). |

### 2.4 Variantes de MCP para Blender

Não existe um "MCP oficial do Blender". O ecossistema é de terceiros e varia em escopo e postura de segurança:

- **`mcp-for-blender`** (ex-`blender-mcp`): o mais difundido; foco em copiloto de sessão aberta, código + `look` + assets ([27](#f27), [28](#f28)).
- **`yuri-schmaltz/mcp_blender`**: repositório com um `SECURITY.md` próprio, sinal de que a comunidade passou a tratar o risco de execução arbitrária como parte do produto ([29](#f29)).
- **`blendmcp`**: pacote PyPI alternativo, mesma ideia geral de ponte MCP↔Blender ([30](#f30)).
- **Integrações proprietárias/plugins** (Codex, Cursor, VS Code etc.) que empacotam o mesmo servidor para diferentes hosts ([27](#f27)).

O padrão comum: um addon dentro do Blender + um processo servidor MCP fora + uma ferramenta de execução de código + uma ferramenta de imagem. A qualidade e a segurança variam; a arquitetura não.

---

## 3. Como o ChatGPT/OpenAI faz o equivalente

### 3.1 Function calling: o mesmo loop, outro nome

A documentação da OpenAI define function calling (também "tool calling") como a forma de o modelo pedir funções externas definidas por JSON Schema ([17](#f17)). O fluxo é: você envia a lista de ferramentas; o modelo pode responder com um `function_call` (nome + argumentos); sua aplicação executa; você devolve um `function_call_output` referenciando o `call_id`; o modelo continua ([17](#f17)). A Responses API é a interface recomendada para os modelos mais novos; Chat Completions continua para integrações existentes ([17](#f17)). `strict: true` aperta a aderência ao schema ([17](#f17)).

Além das funções do usuário, a plataforma oferece ferramentas embutidas: busca web, **code interpreter**, **computer use**, **MCP remoto**, geração de imagem, `tool_search` para carregar definições sob demanda ([18](#f18)). O padrão de segurança também aparece: MCP remoto tem configuração de aprovação (`require_approval`) e o modelo pode pedir confirmação antes de chamar ferramentas sensíveis ([18](#f18)).

### 3.2 Code Interpreter: sandbox, não o seu Blender

O Code Interpreter permite ao modelo escrever e rodar Python em um ambiente **sandboxed** para análise de dados, arquivos e imagens; a documentação diz explicitamente que o modelo pode "reescrever e rodar de novo até funcionar" ([20](#f20)). Ele pode recortar, dar zoom, rotacionar e ler pixels de uma imagem com Python ([20](#f20)). Isso é útil para **avaliar** um render (métricas, histogramas, comparação), mas **não** é o Blender da máquina do usuário: é um contêiner da OpenAI, sem a cena, sem GPU e sem `bpy` do artista ([20](#f20)).

Consequência para o nosso desenho: o crítico visual pode ser implementado com Python puro (SSIM/ΔE/PSNR) no nosso servidor, sem depender de um sandbox de modelo. E o Code Interpreter é um bom precedente de "ferramenta que itera sobre arquivos e imagens", não de "ferramenta que dirige DCC".

### 3.3 Computer use: clicar na UI, em ambiente controlado

Computer use dá ao modelo screenshot + mouse/teclado para interagir com um desktop ([21](#f21)). Em teoria, isso poderia operar a UI do Blender; na prática, a própria documentação recomenda VM/contêiner dedicado, sem dados sensíveis, e trata os riscos como sérios ([5](#f5) para Claude; [21](#f21) para OpenAI). Não é o caminho recomendado para modelagem determinística: é caro, frágil, difícil de reproduzir e não produz um artefato auditável (spec/`.blend` + manifesto).

### 3.4 Canvas: produto, não API de Blender

O **Canvas** do ChatGPT é uma superfície de edição para textos/código/projetos, aberta dentro do produto; não é uma API pública de ferramentas para DCC e não expõe `bpy` ([25](#f25), [26](#f26)). As páginas oficiais bloquearam acesso automatizado (HTTP 403) na verificação, então a afirmação aqui é deliberadamente conservadora: **Canvas é uma interface de edição do ChatGPT, não um integrador de Blender**. Para o nosso problema, Canvas não substitui uma ponte de execução; no máximo inspira a UX de "documento/plano editável ao lado do resultado".

### 3.5 O que é produto e o que é demo

| Coisa | Natureza | Alcança o Blender local? |
| --- | --- | --- |
| Function calling / tools (API) | Produto de plataforma | Sim, se **você** executar a função (ou um MCP remoto). |
| MCP connector / remote MCP | Produto de plataforma | Sim, para servidores MCP acessíveis; não é um addon local por mágica. |
| Code Interpreter | Produto (sandbox) | Não; roda em contêiner isolado. |
| Computer use | Produto (beta/estável, ambiente controlado) | Sim, via UI, num desktop que você fornece; não é o desktop do usuário por padrão. |
| Canvas | Produto de interface | Não. |
| `mcp-for-blender` / variantes | Terceiros/open source | Sim, com addon + socket na máquina. |
| Demos de "ChatGPT modela no Blender" | Demonstração/integração de terceiros | Depende de uma ponte externa; não é integração oficial. |

**Conclusão honesta:** não encontrei, nas fontes primárias consultadas, um produto oficial da Anthropic ou da OpenAI que abra o Blender do usuário e o conduza sozinho. O que existe é uma **capacidade genérica** (tool calling + visão) e **integrações de terceiros** que a usam. Isso é bom para nós: o valor não está no transporte, está no contrato de cena, no loop com crítica e no gate humano.

---

## 4. O loop real: intenção → plano → comando → render → crítica → correção

### 4.1 O esqueleto

```text
pedido do usuário
      │
      ▼
[modelo] interpreta intenção e propõe um plano (texto/etapas)
      │  tool_use / function_call
      ▼
[cliente] executa: addon/socket (bpy) ou API do Director (scene-spec)
      │  tool_result / function_call_output
      ▼
[render] preview (still de baixa resolução) ou screenshot da viewport
      │  imagem + logs
      ▼
[modelo] olha a imagem, compara com o objetivo, lista correções
      │  novo tool_use / function_call
      └──────────────► repete até aprovar ou desistir
```

Esse esqueleto é o mesmo em [2](#f2) (loop de tool use), [17](#f17) (function calling) e no README do `mcp-for-blender` (código + `look` + correção) ([27](#f27)). A diferença está em **quem guarda o estado** e **como a imagem é obtida**:

- No MCP de Blender: estado = sessão aberta do Blender; imagem = `look` sob demanda; execução = Python na sessão.
- No nosso Director: estado = scene-spec v1 + manifesto; imagem = preview PNG por SSE; execução = `build.py` headless, com schema fechado.

### 4.2 Quantas iterações?

**Não há número oficial.** Nenhuma das documentações consultadas publica uma média de iterações para "modelar no Blender". O que dá para afirmar com fonte:

- o loop não tem limite intrínseco para ferramentas de cliente; ele termina por `end_turn`, `max_tokens`, recusa ou decisão da aplicação ([2](#f2));
- ferramentas de servidor têm um limite interno de iteração e devolvem `pause_turn` ([2](#f2));
- o code interpreter pode reescrever/reexecutar até funcionar, mas isso ocorre dentro de um turno/limite ([20](#f20));
- o README do MCP de Blender diz que operações complexas precisam ser quebradas em passos menores ([27](#f27)).

Com base nisso, uma **estimativa de engenharia** (não medição):

| Cenário | Rodadas de modelo + ferramenta | Observação |
| --- | --- | --- |
| Primitiva única, câmera/luz padrão | 2–4 | 1 para montar, 1–2 para olhar/corrigir, 1 para finalizar. |
| Produto com material, fundo e enquadramento | 4–8 | Cada correção de cor/luz pede novo preview. |
| Cena com vários objetos, composição e referência | 8–20+ | A crítica visual vira o gargalo; contexto cresce. |
| Personagem/interior "de verdade" | muito mais | Fora do que um schema fechado cobre bem; tende a virar modelagem manual. |

Marcar como estimativa é obrigatório: o número real depende do modelo, da ferramenta, da resolução da imagem e do critério de "pronto". É exatamente por isso que a v2 deve ter **orçamento de iterações** e **critério de parada explícito**, não "até parecer bom".

### 4.3 Como tratam erro de API do Blender

O padrão observado:

1. **Erro volta como resultado de ferramenta**, não como exceção do modelo. No MCP, a resposta tem `status` e `message`; no tool use, o `tool_result` pode carregar `is_error`/texto de erro ([2](#f2), [27](#f27)).
2. **O modelo lê o traceback e tenta de novo**, muitas vezes com código mais simples ([27](#f27), [20](#f20)).
3. **Safe mode devolve o motivo do bloqueio** para o modelo corrigir ([27](#f27)).
4. **Limites de API viram retry/backoff**: rate limit por token bucket, erros 429, rajadas ([7](#f7)). Do lado do Blender, timeout/exit code precisa ser tratado pelo cliente, porque o modelo não vê o processo — só o resultado que o cliente reportar.

O que **não** existe: garantia de que o erro foi corrigido na primeira tentativa, rollback automático da cena ou validação semântica do resultado. O loop é heurístico.

### 4.4 A "crítica visual" que o modelo faz

O modelo não tem um medidor de SSIM embutido. Ele "olha" a imagem e raciocina sobre composição, cor, iluminação, proporção e artefatos. Isso é poderoso para direção e fraco para precisão:

- **Bom**: perceber que a câmera cortou o objeto, que a luz está dura, que o fundo ficou lavado, que a cor não bate com a referência.
- **Fraco**: comparar tons numericamente, detectar desalinhamento sutil, julgar ruído em baixa resolução, medir fidelidade a uma referência.
- **Risco**: "alucinar" que está certo; confiar em uma screenshot de viewport que não representa o render final.

Por isso a v2 propõe um crítico **híbrido**: métricas objetivas (SSIM/ΔE00/PSNR) + checklist + modelo. O modelo continua sendo o diretor; as métricas são o instrumento de medida. Nenhum dos dois "promete realismo absoluto".

---

## 5. O que é específico de cada um e o que é padrão da indústria

| Aspecto | Claude/Anthropic | ChatGPT/OpenAI | Padrão da indústria |
| --- | --- | --- | --- |
| Chamada de ferramenta | `tool_use` / `tool_result`, loop por `stop_reason` ([1](#f1), [2](#f2)) | `function_call` / `function_call_output`, `call_id` ([17](#f17)) | JSON Schema + chamada + resultado + repetição. |
| Descoberta de ferramentas | MCP (`tools/list`, capabilities) ([11](#f11)) | tools declaradas + `tool_search` ([18](#f18)) + MCP remoto ([24](#f24)) | Lista de ferramentas com descrição/schema; às vezes busca dinâmica. |
| Transporte | MCP local (STDIO/HTTP) e MCP connector remoto ([3](#f3), [10](#f10)) | API + conectores MCP remotos ([24](#f24)) | Protocolo de contexto separado do modelo. |
| Visão sobre render | blocos de imagem; screenshots via `look`/computer use ([4](#f4), [27](#f27)) | `image_url`/base64, detail, code interpreter para pixels ([19](#f19), [20](#f20)) | Imagem entra como token; resolução importa e custa. |
| Loop de correção | cliente dirige; servidor tem `pause_turn` ([2](#f2)) | cliente/agente dirige; code interpreter itera ([17](#f17), [20](#f20)) | Iteração com observação, sem garantia de convergência. |
| Aprovação humana | recomendada no MCP; computer use exige cuidado ([11](#f11), [5](#f5)) | `require_approval` em MCP; computer use com consentimento ([18](#f18), [21](#f21)) | Human-in-the-loop para ações com efeito. |
| Execução de código | cliente executa (ou servidor, em sandbox) ([2](#f2)) | code interpreter em sandbox ([20](#f20)) | Sandbox ou schema fechado; nunca "confiança implícita". |
| Superfície de produto | Claude Desktop/Code + MCPs de terceiros | ChatGPT + Canvas + ferramentas de API ([25](#f25)) | O produto é o host; a integração é ecossistema. |

**O que é realmente específico:**

- **Anthropic:** MCP como protocolo de primeira classe (não só uma lista de funções), blocos `tool_use`/`tool_result` no formato da Messages API, `computer_toolset` com ferramentas nomeadas ([2](#f2), [3](#f3), [5](#f5)).
- **OpenAI:** Responses API como eixo, ferramentas embutidas (code interpreter, computer use, MCP remoto), `strict` schemas, contabilização de imagem por patches, `tool_search` ([17](#f17), [18](#f18), [19](#f19), [23](#f23)).
- **Específico de Blender:** a ponte addon + socket + execução de Python na sessão aberta; o `look` como "olho" sob demanda ([27](#f27)).

**O que é padrão:** function calling com schema, resultado de ferramenta como texto/imagem, loop com observação, necessidade de aprovação humana e sandbox/schema fechado. Ou seja: a "mágica" não está no modelo, está no **contrato** e no **loop bem instrumentado**.

---

## 6. Comparação honesta com o nosso Blender Director

### 6.1 O que já temos

| Capacidade | Onde | Situação |
| --- | --- | --- |
| Scene-spec JSON fechado e validado | `tools/blender-director/lib/spec.js`, `schema.md` | Funciona; erros cedo com mensagem em português. |
| Execução headless com `build.py` e fixture | `build.py`, `fake-blender.js` | Contrato coberto; **não executado no Blender real** neste repositório. |
| Preview + SSE + manifesto | `server.js`, `renderer.js`, `viewer/` | Funciona em fixture; preview 640/32 por etapa. |
| Comandos incrementais (luz, material, câmera) | `POST /jobs/:id/commands` | Funciona; reconstrói a cena a partir do spec. |
| Gate de aprovação humana | `POST /jobs/:id/approve` | Funciona; bloqueia a fila até aprovar. |
| Fila, timeout, limites de corpo, origem local | `server.js` | Funciona; um job ativo por vez. |
| Planner (fase 1) | `planner.js` + `POST /plan` | Novo: pedido → plano + scene-spec v1, por regras, com gancho de modelo. |
| Crítico (esqueleto) | `critic.js` | Novo: métricas → correções priorizadas; ainda não calcula imagem. |
| Memória de cena | — | **Falta** (proposta na spec v2). |
| Integração com modelo real | — | **Falta** (gancho existe; implementação fica para a fase 2). |
| UI de participação ao vivo | `viewer/index.html` | Tem timeline/preview/aprovação e, agora, "pedido → plano"; falta a visão de crítica/correções. |

### 6.2 O que os assistentes têm que nós ainda não temos

| Lacuna | O que o Claude/ChatGPT faz | O que precisamos |
| --- | --- | --- |
| Intenção | Interpreta pedido ambíguo e pergunta | Planner com desambiguação (já iniciado) + modelo na fase 2. |
| Crítica visual | Olha a imagem e descreve o que corrigir | Métricas + checklist + modelo; hoje só o esqueleto de métricas. |
| Memória | Histórico da conversa/sessão | Ledger de cena versionado (não a conversa). |
| Iteração rápida | `look` + código na sessão | Preview rápido por SSE; já temos, falta o crítico automático. |
| Vocabulário | Qualquer `bpy` (poder e risco) | Schema fechado (segurança e reprodutibilidade) + extensões explícitas. |

### 6.3 O que **não** vale copiar

1. **`execute_blender_code` como caminho padrão.** É poderoso, mas transforma qualquer prompt injection em execução de código no host ([27](#f27)). O nosso schema fechado é uma vantagem; não devemos abrir mão dela por conveniência.
2. **Conversa como fonte de verdade.** Repetir o pedido não reproduz a cena; auditoria fica impossível. Spec + manifesto + memória versionada é melhor.
3. **Loop sem orçamento.** "Até parecer bom" queima tokens, tempo de GPU e paciência. Precisa de limite de iterações, critério de parada e custo estimado.
4. **Screenshot de viewport como prova de render.** Viewport não é o render final (materiais, luz, denoise, DOF). A crítica tem que ser sobre o preview/final que o usuário vai aprovar.
5. **Expor a porta do socket sem auth.** O README do MCP de Blender avisa; nós já escutamos só em `127.0.0.1` e rejeitamos origem externa. Manter.
6. **Streaming de viewport a 60 fps como requisito.** É caro e complexo; para direção por etapas, stills por SSE resolvem. Só faz sentido se o produto exigir "ver a cena se mexer".

### 6.4 O que vale copiar/adaptar

- **Contrato explícito de ferramenta** (nome, descrição, schema, resultado), como no MCP/function calling ([11](#f11), [17](#f17)).
- **Observação por imagem** com uma ferramenta dedicada (`look`, `screenshot`) em vez de misturar imagem no meio do texto ([27](#f27), [4](#f4)).
- **Resultado de erro como dado**, não como exceção: o crítico/executor devolve `{ok:false, error, hint}` e o planner decide.
- **Human-in-the-loop** e confirmação para ações com efeito ([11](#f11), [18](#f18)).
- **Orçamento de contexto/imagem**: downsamplar preview e mandar só o necessário; imagens contam tokens ([4](#f4), [23](#f23)).

---

## 7. Custos, latência e limites

### 7.1 Custos de token (preços publicados, por milhão de tokens)

Valores de tabela oficial na data da pesquisa; preços mudam, confira a página vigente ([8](#f8), [22](#f22)):

| Modelo | Entrada | Saída | Observação |
| --- | --- | --- | --- |
| Claude Opus 5.5 | US$ 4 / MTok | US$ 20 / MTok | Topo de linha; imagem em alta resolução custa mais tokens. |
| Claude Sonnet 5.5 | US$ 2 / MTok | US$ 10 / MTok | Bom equilíbrio para o loop. |
| Claude Haiku 5.5 | US$ 0,10 / MTok (até 100k) | US$ 0,50 / MTok | Barato; acima de 100k, US$ 0,50/US$ 2,50. |
| GPT-5.4 | US$ 2,50 / MTok | US$ 15 / MTok | Tabela OpenAI. |
| GPT-4o | US$ 2,50 / MTok | US$ 10 / MTok | Modelo mais antigo, ainda listado. |
| GPT-5.4-mini | US$ 0,75 / MTok | US$ 4,50 / MTok | Opção de custo. |

**Imagem não é grátis.** No Claude, a imagem é cobrada em "patches" de 28×28 px: `⌈largura/28⌉ × ⌈altura/28⌉` tokens visuais ([4](#f4)). Exemplos da própria documentação ([4](#f4)):

| Imagem | Tokens visuais | Custo aproximado em Opus 5.5 (US$ 4/MTok) |
| --- | --- | --- |
| 200×200 | 64 | ~US$ 0,00026 |
| 1000×1000 | 1.296 | ~US$ 0,0052 |
| 1920×1080 (alta resolução) | 2.691 | ~US$ 0,0108 |
| 3840×2160 (alta resolução) | 4.784 | ~US$ 0,0191 |

Um preview 640×426 custa `⌈640/28⌉ × ⌈426/28⌉ = 23 × 16 = 368` tokens visuais — barato por imagem, mas o loop reenvia o histórico e acumula. No OpenAI, a imagem também consome tokens e há um limite de 30.000 patches por imagem; `detail` alto/original custa mais e pode ser rejeitado se passar do limite ([19](#f19), [23](#f23)).

**Estimativa de custo por iteração** (não é benchmark; assuma ordem de grandeza):

- 1 preview 640×426 ≈ 368 tokens visuais;
- 2–3 mil tokens de instruções/código/resultados;
- 500–1.500 tokens de saída;
- a cada rodada, o histórico anterior é reenviado (custo cresce com o número de rodadas).

Em Sonnet 5.5, uma rodada de ~4k entrada + ~1k saída fica na casa de **US$ 0,02**; cinco rodadas com histórico acumulado podem ficar em **US$ 0,10–0,30**. Em Opus 5.5, multiplique por ~2; em Haiku, divida por ~20. O gargalo de custo real costuma ser **imagem em alta resolução + contexto acumulado**, não o texto do pedido.

### 7.2 Latência

| Etapa | Ordem de grandeza | Fonte/observação |
| --- | --- | --- |
| Round trip de ferramenta | pelo menos 1 request adicional ao modelo ([2](#f2)) | Latência do modelo domina; MCP local em si é rápido. |
| Render de preview 640/32 | segundos (2–12 s é estimativa nossa em RTX 3060) | [README interno](../tools/blender-director/README.md); fixture grava tempos fictícios. |
| Render final 1200×800/128 | dezenas de segundos a minutos (30–180 s estimado) | [README interno](../tools/blender-director/README.md); varia com cena/GPU. |
| Uma rodada completa (modelo + ferramenta + preview) | ~10–60 s típico, dependendo do modelo e da cena | Soma das partes; sem benchmark público. |
| Loop de 5 correções | minutos, não segundos | Consequência das linhas acima. |

O ponto de arquitetura: **preview tem que ser barato e rápido**; se cada iteração custa um render final, o loop fica inviável. É por isso que o Director usa preview 640/32 e só libera o final depois da aprovação.

### 7.3 Limites que afetam o loop

| Limite | Valor/documento | Consequência |
| --- | --- | --- |
| Contexto Claude | até 1M tokens; 200k em modelos antigos ([6](#f6)) | Contexto acumula; "context rot" degrada precisão ([6](#f6)). |
| Imagens por request | 600 (modelos atuais), 100 (200k), 20 por mensagem no claude.ai ([4](#f4)) | Loop longo com screenshot a cada passo estoura. |
| Tamanho de imagem | 10 MB base64 (API), 8000×8000; 5 MB no Bedrock ([4](#f4)) | Preview deve ser pequeno; não mande EXR. |
| Muitas imagens | >20 imagens ativa limite de dimensão mais estrito; manter ≤3.000 px ([4](#f4)) | Evite mandar a prancha inteira sem necessidade. |
| Rate limit Claude | token bucket por tier, 429; rajadas podem furar ([7](#f7)) | Cliente precisa de retry/backoff. |
| OpenAI imagem | 30.000 patches; `detail` alto/original; redimensionamento ([23](#f23)) | Imagem 6000×6000 pode ser rejeitada em `original`. |
| Blender/GPU | VRAM 12 GB (alvo), timeout de render | Fila serial e timeout são obrigatórios. |

---

## 8. Riscos, inclusive executar `bpy` arbitrário

### 8.1 O risco central

O `mcp-for-blender` declara: `execute_blender_code` roda Python arbitrário, é "potente, mas potencialmente perigoso", e o usuário deve salvar o trabalho antes ([27](#f27)). O socket do addon **não tem autenticação nem criptografia**; quem alcança a porta pode rodar Python no Blender ([27](#f27)). O safe mode é opt-in e bloqueia arquivos/rede/processos, mas não é o padrão ([27](#f27)).

Isso significa que o modelo — ou um prompt injection escondido em um nome de objeto, textura, asset da internet ou resposta de ferramenta — pode, em tese:

- ler/gravar arquivos no host;
- abrir conexões de rede e exfiltrar dados;
- executar processos;
- apagar/sobrescrever o `.blend` do usuário.

O MCP spec recomenda human-in-the-loop para ferramentas ([11](#f11)), e o documento de segurança do MCP cataloga classes de ataque relevantes: *confused deputy*, *token passthrough*, *SSRF*, *session hijacking*, *local MCP server compromise* ([14](#f14)). A documentação de computer use da Anthropic recomenda VM/contêiner dedicado e evitar dados sensíveis ([5](#f5)).

### 8.2 Riscos específicos do nosso contexto

| Risco | Descrição | Mitigação no Director |
| --- | --- | --- |
| Execução arbitrária | Spec não executa Python; `build.py` interpreta um conjunto fechado de campos ([schema v1](../tools/blender-director/schema.md)) | Manter schema fechado; não aceitar `bpy` no spec. |
| Prompt injection | Pedido/asset pode instruir o modelo a "ignorar regras" | Modelo só propõe plano/spec; validação e gate humano decidem. |
| Exposição de rede | Servidor local e socket | Escutar `127.0.0.1`, rejeitar `Origin` externo, não expor porta ([README interno](../tools/blender-director/README.md)). |
| Custo descontrolado | Loop sem limite queima tokens | Orçamento de iterações, preview barato, critério de parada. |
| Drift de estado | Comando aplicado sem registro | Memória de cena versionada (spec v2). |
| Métrica enganosa | SSIM alto com imagem borrada/desalinhada | Métricas múltiplas + checklist + inspeção humana. |
| Dependência de terceiros | MCP/addon de terceiros, supply chain | Fixar versão, revisar código, não dar rede/segredos ao processo. |
| Vazamento de dados | Telemetria/asset download | Sem telemetria no nosso servidor; assets locais; sem rede por padrão. |

### 8.3 O que a v2 deve garantir

1. **Nenhum `bpy` arbitrário vindo do modelo.** O modelo produz um plano/scene-spec; o executor só aceita o vocabulário validado.
2. **Aprovação explícita** para render final e para qualquer operação destrutiva.
3. **Limites duros**: tamanho de corpo, número de objetos, samples, tempo de render, iterações.
4. **Auditoria**: `manifest.json` + memória de cena + log de decisões do crítico.
5. **Falha segura**: erro vira estado `error` com log; nunca "segue como se tivesse dado certo".

---

## 9. O que a v2 deve copiar, adaptar e evitar

**Copiar (com adaptação):**

- o contrato de ferramenta explícito e a separação "modelo propõe / aplicação executa" ([2](#f2), [17](#f17));
- a observação por imagem dedicada, com uma ferramenta de "olhar" ([27](#f27));
- o padrão de erro como resultado estruturado, para o loop corrigir;
- o human-in-the-loop e a confirmação de ações ([11](#f11), [18](#f18));
- a ideia de orçamento de contexto/imagem e downsample de preview ([4](#f4), [23](#f23)).

**Adaptar:**

- MCP pode ser a **interface** para um artista/copiloto; o Director continua sendo o **pipeline auditável** com spec + manifesto + aprovação;
- `look` vira "crítico sob demanda" sobre o preview, não screenshot de viewport;
- a memória de cena substitui o histórico da conversa como fonte de verdade;
- o crítico híbrido (métricas + checklist + modelo) substitui "só olhar".

**Evitar:**

- execução de Python arbitrário por padrão;
- loop sem limite/orçamento;
- conversa como estado;
- screenshot de viewport como prova de render;
- exposição de socket sem auth;
- prometer "realismo absoluto" ou "fotorrealismo garantido".

Essas decisões estão detalhadas na [spec da v2](./spec-blender-director-v2.md).

---

## 10. O que foi verificado e o que não foi

### 10.1 Verificado em fonte primária (2026-11-04)

- Documentação da Anthropic sobre tool use, loop, ferramentas de cliente/servidor, `pause_turn`, MCP connector, visão, computer use, contexto, rate limits e preços ([1](#f1)–[8](#f8)).
- Especificação MCP: visão geral, arquitetura host/cliente/servidor, tools/resources/prompts e boas práticas de segurança ([9](#f9)–[16](#f16)).
- Documentação da OpenAI: function calling, tools embutidas, imagens/visão, code interpreter, computer use, preços, calculadora de custo de imagem e MCP remoto ([17](#f17)–[24](#f24)).
- README do `mcp-for-blender` (ex-`blender-mcp`), incluindo arquitetura addon+socket, lista de ferramentas, limites e avisos de segurança ([27](#f27)).
- Documentação do Blender: API `bpy`, argumentos de linha de comando, Cycles e release notes 5.2 ([31](#f31)–[34](#f34)).
- Referências de métricas: SSIM (DOI), CIEDE2000, scikit-image, LPIPS, OIDN e pbrt ([35](#f35)–[40](#f40)).
- **Status HTTP:** 38 das 40 URLs retornaram 200/202; as duas páginas oficiais do Canvas ([25](#f25), [26](#f26)) retornaram 403 para cliente automatizado e estão marcadas como não lidas integralmente.

### 10.2 Não verificado / limitações honestas

- **Não houve execução real de Claude ou ChatGPT.** Sem chaves de API, sem conta e sem orçamento; a análise é documental. Não medi custo, latência nem número de iterações.
- **Não há Blender instalado neste ambiente.** O `build.py` do Director não foi executado no Blender real; o modo fixture cobre contrato/eventos, não imagem. O `mcp-for-blender` também não foi executado.
- **Não há benchmark público de iterações.** Os intervalos da seção 4.2 são estimativa de engenharia, não medição; estão rotulados como tal.
- **Preços e nomes de modelos mudam.** A tabela reflete a documentação na data; confira a página vigente antes de orçar.
- **Canvas:** as páginas oficiais bloquearam automação (403); a afirmação de que Canvas é superfície de produto, não API de Blender, é conservadora e baseada no que a documentação pública permite afirmar.
- **Variantes de MCP:** li README/repositório, mas não auditei o código de cada uma; a lista não é exaustiva nem um endosso.
- **Segurança:** não fiz teste de intrusão nem reproduzi prompt injection; os riscos vêm da documentação e do aviso explícito do projeto.
- **Métricas:** não implementei SSIM/ΔE/PSNR nesta fase; o `critic.js` só consome métricas prontas. A spec descreve o método, não um resultado.

---

## 11. Fontes

> Verificação por HTTP em 2026-11-04. "Usado para" indica a seção/afirmação que a fonte sustenta.

### Anthropic / Claude

<a id="f1"></a>1. **Anthropic — Tool use with Claude (overview)**. <https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview> — definição de tool use, ferramentas de cliente/servidor. (HTTP 200)
<a id="f2"></a>2. **Anthropic — How tool use works**. <https://platform.claude.com/docs/en/agents-and-tools/tool-use/how-tool-use-works> — contrato, loop `stop_reason`, `tool_use`/`tool_result`, `pause_turn`, latência de round trip. (HTTP 200)
<a id="f3"></a>3. **Anthropic — MCP connector**. <https://platform.claude.com/docs/en/agents-and-tools/mcp-connector> — `mcp_servers`/`mcp_toolset`, MCP remoto na Messages API (beta). (HTTP 200)
<a id="f4"></a>4. **Anthropic — Vision**. <https://platform.claude.com/docs/en/build-with-claude/vision> — blocos de imagem, limites, patches 28×28, custo por imagem. (HTTP 200)
<a id="f5"></a>5. **Anthropic — Computer use tool**. <https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool> — screenshot/mouse/teclado, riscos e recomendações de VM. (HTTP 200)
<a id="f6"></a>6. **Anthropic — Context windows**. <https://platform.claude.com/docs/en/build-with-claude/context-windows> — 1M tokens, 600 imagens, o que conta no contexto, context rot. (HTTP 200)
<a id="f7"></a>7. **Anthropic — Rate limits**. <https://platform.claude.com/docs/en/api/rate-limits> — token bucket, tiers, 429 e rajadas. (HTTP 200)
<a id="f8"></a>8. **Anthropic — Pricing**. <https://platform.claude.com/docs/en/about-claude/pricing> — preços por MTok (Opus/Sonnet/Haiku). (HTTP 200)

### Model Context Protocol (MCP)

<a id="f9"></a>9. **MCP — Specification: Overview (2025-11-25)**. <https://modelcontextprotocol.io/specification/2025-11-25/basic> — JSON-RPC 2.0, componentes, features de servidor/cliente. (HTTP 200)
<a id="f10"></a>10. **MCP — Architecture overview**. <https://modelcontextprotocol.io/docs/learn/architecture> — host, cliente, servidor; STDIO e Streamable HTTP. (HTTP 200)
<a id="f11"></a>11. **MCP — Tools**. <https://modelcontextprotocol.io/specification/2025-11-25/server/tools> — `tools/list`, `inputSchema`, model-controlled, human-in-the-loop. (HTTP 200)
<a id="f12"></a>12. **MCP — Resources**. <https://modelcontextprotocol.io/specification/2025-11-25/server/resources> — recursos de contexto e seleção pelo usuário. (HTTP 200)
<a id="f13"></a>13. **MCP — Prompts**. <https://modelcontextprotocol.io/specification/2025-11-25/server/prompts> — prompts reutilizáveis e tipos de conteúdo. (HTTP 200)
<a id="f14"></a>14. **MCP — Security Best Practices**. <https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices> — confused deputy, token passthrough, SSRF, session hijacking, comprometimento de servidor local. (HTTP 200)
<a id="f15"></a>15. **MCP — Reference servers**. <https://github.com/modelcontextprotocol/servers> — implementações de referência e padrões. (HTTP 200)
<a id="f16"></a>16. **JSON-RPC 2.0 Specification**. <https://jsonrpc.org/specification> — base de mensagens do MCP. (HTTP 200)

### OpenAI / ChatGPT

<a id="f17"></a>17. **OpenAI — Function calling**. <https://platform.openai.com/docs/guides/function-calling> — funções por JSON Schema, `function_call`/`function_call_output`, `call_id`, loop. (HTTP 200)
<a id="f18"></a>18. **OpenAI — Tools**. <https://developers.openai.com/api/docs/guides/tools> — ferramentas embutidas, MCP remoto, code interpreter, computer use, `tool_search`, aprovação. (HTTP 200)
<a id="f19"></a>19. **OpenAI — Images and vision**. <https://developers.openai.com/api/docs/guides/images-vision> — imagem por URL/base64, `detail`, tokens. (HTTP 200)
<a id="f20"></a>20. **OpenAI — Code Interpreter**. <https://developers.openai.com/api/docs/guides/tools-code-interpreter> — sandbox Python, iteração, inspeção de pixels. (HTTP 200)
<a id="f21"></a>21. **OpenAI — Computer use**. <https://developers.openai.com/api/docs/guides/tools-computer-use> — browser/desktop, ambiente controlado. (HTTP 200)
<a id="f22"></a>22. **OpenAI — Pricing**. <https://developers.openai.com/api/docs/pricing> — tabela por 1M tokens. (HTTP 200)
<a id="f23"></a>23. **OpenAI — Image input token and cost calculator**. <https://developers.openai.com/api/docs/guides/image-cost-calculator> — patches, `detail`, limite de 30.000 patches. (HTTP 200)
<a id="f24"></a>24. **OpenAI — Remote MCP servers**. <https://developers.openai.com/api/docs/guides/tools-connectors-mcp> — conectar o modelo a servidores MCP. (HTTP 200)
<a id="f25"></a>25. **OpenAI — Introducing canvas** (anúncio oficial). <https://openai.com/index/introducing-canvas/> — superfície de edição do ChatGPT. (HTTP 403 para automação; não lida integralmente)
<a id="f26"></a>26. **OpenAI Help Center — What is the canvas feature in ChatGPT**. <https://help.openai.com/en/articles/9930697> — uso do Canvas no produto. (HTTP 403 para automação; não lida integralmente)

### Blender e ecossistema MCP de Blender

<a id="f27"></a>27. **Ahuja — MCP for Blender (ex-`blender-mcp`) README**. <https://github.com/ahujasid/blender-mcp> — addon + socket, nove ferramentas, `look`, `execute_blender_code`, safe mode, avisos de segurança, limitações. (HTTP 200)
<a id="f28"></a>28. **PyPI — `mcp-for-blender`**. <https://pypi.org/project/mcp-for-blender/> — pacote/versão do servidor MCP. (HTTP 200)
<a id="f29"></a>29. **Schmaltz — `mcp_blender` SECURITY.md**. <https://github.com/yuri-schmaltz/mcp_blender> — variante com política de segurança explícita. (HTTP 200)
<a id="f30"></a>30. **PyPI — `blendmcp`**. <https://pypi.org/project/blendmcp/> — variante de ponte MCP↔Blender. (HTTP 200)
<a id="f31"></a>31. **Blender — Python API Documentation**. <https://docs.blender.org/api/current/> — API `bpy` usada pelo addon/código. (HTTP 200)
<a id="f32"></a>32. **Blender Manual — Command Line Arguments**. <https://docs.blender.org/manual/en/latest/advanced/command_line/arguments.html> — execução headless (`-b`, `-P`, `--python-exit-code`). (HTTP 200)
<a id="f33"></a>33. **Blender Manual — Cycles**. <https://docs.blender.org/manual/en/latest/render/cycles/index.html> — render fisicamente baseado. (HTTP 200)
<a id="f34"></a>34. **Blender — Release Notes 5.2**. <https://developer.blender.org/docs/release_notes/5.2/> — versão alvo do pipeline. (HTTP 200)

### Métricas e render

<a id="f35"></a>35. **Wang et al. — Image Quality Assessment: From Error Visibility to Structural Similarity (SSIM)**. <https://doi.org/10.1109/TIP.2003.819861> — definição de SSIM (registro DOI; acesso ao texto pode ser bloqueado). (HTTP 202)
<a id="f36"></a>36. **Sharma — The CIEDE2000 Color-Difference Formula**. <https://hajim.rochester.edu/ece/sites/gsharma/ciede2000/> — ΔE00, implementação e valores de teste. (HTTP 200)
<a id="f37"></a>37. **scikit-image — Metrics**. <https://scikit-image.org/docs/stable/api/skimage.metrics.html> — SSIM/PSNR como implementação de referência. (HTTP 200)
<a id="f38"></a>38. **Zhang et al. — The Unreasonable Effectiveness of Deep Features as a Perceptual Metric (LPIPS)**. <https://arxiv.org/abs/1801.03924> — métrica perceptual baseada em rede. (HTTP 200)
<a id="f39"></a>39. **OpenImageDenoise**. <https://openimagedenoise.github.io/> — denoiser usado em preview/final. (HTTP 200)
<a id="f40"></a>40. **Physically Based Rendering (pbrt)**. <https://pbrt.org/> — referência de transporte de luz/render físico. (HTTP 200)
