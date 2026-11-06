# Modelagem medida de sala e fotorrealismo verificável — pesquisa para o Blender Director v3

**Data da pesquisa:** 2026-11-04
**Escopo:** a fase v3 do Blender Director — sala de estar medida em metros, aberturas de janela por boolean, assets livres (Poly Haven, ambientCG, BlenderKit), light rig dia/crepúsculo/noite e comparação objetiva contra uma imagem de referência.
**Método:** documentação primária de Anthropic, OpenAI, Model Context Protocol, Blender, Khronos, Poly Haven, ambientCG e BlenderKit; literatura revisada por pares sobre métricas de imagem; leitura do código da v3 (`build_room.py`, `evaluate.py`, `lib/room.js`, `light-rig-presets.json`); verificação HTTP de cada URL em 2026-11-04; e execução local do Blender 5.2.3 LTS em modo headless para validar os mecanismos de boolean e importação glTF.

> **Resumo em uma frase:** um render fotorrealista verificável não nasce de um prompt maior, e sim de um contrato fechado — geometria em metros, aberturas booleanas, assets com licença e escala conferidas, luz fisicamente plausível, color management correto — e de uma avaliação que diga explicitamente o que cada métrica **não** prova.

## Sumário

1. [Objetivo, escopo e método](#1-objetivo-escopo-e-método)
2. [Como o Claude chega ao Blender](#2-como-o-claude-chega-ao-blender)
3. [Como o ChatGPT/OpenAI faz o equivalente](#3-como-o-chatgptopenai-faz-o-equivalente)
4. [O que separa um render "de demonstração" de um render fotorrealista](#4-o-que-separa-um-render-de-demonstração-de-um-render-fotorrealista)
5. [Padrões de prompt/instrução que produzem modelagem precisa](#5-padrões-de-promptinstrução-que-produzem-modelagem-precisa)
6. [Pipeline de assets gratuitos](#6-pipeline-de-assets-gratuitos)
7. [Métodos de avaliação de fidelidade a uma referência](#7-métodos-de-avaliação-de-fidelidade-a-uma-referência)
8. [Síntese para o pipeline v3](#8-síntese-para-o-pipeline-v3)
9. [O que foi verificado / o que não foi](#9-o-que-foi-verificado--o-que-não-foi)
10. [Fontes](#10-fontes)

---

## 1. Objetivo, escopo e método

### 1.1 O problema da v3

A v1/v2 do Blender Director já provou o contrato de cena: um JSON fechado, um executor headless, preview por SSE e gate de aprovação humana. A v3 muda a natureza do alvo. Não é mais "gerar uma cena plausível"; é **reproduzir uma sala medida** a partir de uma fotografia de referência, com seis exigências que interagem:

| Exigência da v3 | Pergunta de pesquisa correspondente |
| --- | --- |
| Planta em metros, paredes com espessura e aberturas reais | Como garantir escala e unidades sem depender do "olho" do modelo? |
| Janelas recortadas por boolean, com esquadria e vidro | Qual configuração de boolean é robusta o suficiente para automação? |
| Assets gratuitos importados (Poly Haven, ambientCG, BlenderKit) | Quais formatos, licenças e convenções de escala usar? |
| Light rig dia/crepúsculo/noite | O que a luz precisa ter para não parecer "render de demo"? |
| Comparação objetiva contra a referência | O que SSIM, ΔE00, IoU e histograma realmente medem — e o que eles não provam? |
| Instruções para um agente modelar com precisão | Que padrões de prompt/contrato reduzem ambiguidade e alucinação? |

A pergunta que organiza tudo: **o que, num pipeline desse tipo, é engenharia verificável e o que é apenas retórica de "fotorrealismo"?** A resposta curta é que escala, aberturas, texturas, luz e color management são verificáveis; "parecer uma foto" não é demonstrável por um único número (seção 7).

### 1.2 O que foi pesquisado

- **Agentes:** o contrato de tool use da Anthropic, o protocolo MCP, o addon/servidor `blender-mcp` e a execução de `bpy` em sessão viva; function calling e ferramentas embutidas da OpenAI, Canvas, Actions e o addon comunitário BlenderGPT.
- **Blender:** unidades métricas, boolean EXACT, Principled BSDF, luzes, HDRI, câmera/DOF, sampling/denoise, color management (Standard/Filmic/AgX), bevel, importação de `.blend` e glTF.
- **Assets:** licenças e formatos de Poly Haven, ambientCG e BlenderKit; convenções do glTF 2.0; armadilhas de importação.
- **Métricas:** IoU de silhueta, SSIM, CIEDE2000, histograma, comparação por regiões, LPIPS; fórmulas, implementações e limites.
- **Instruções:** decomposição, dimensões explícitas, critérios de aceitação por região, saída JSON, auto-checagem e restrições.

### 1.3 Critérios de seleção

| Tipo | Critério | Exemplos usados |
| --- | --- | --- |
| Primária | Documentação oficial do fabricante, especificação, manual do projeto, paper revisado por pares | Anthropic, OpenAI, MCP, Blender, Khronos, Poly Haven, ambientCG, BlenderKit, Wang et al., Sharma et al. |
| Secundária confiável | Repositório mantido, thread técnica com reprodução de problema, livro técnico de referência | `ahujasid/blender-mcp`, `gd3kr/BlenderGPT`, BlenderArtists, PBRT, LearnOpenGL, Marmoset |
| Terciária (contexto) | Verbete enciclopédico usado só para definição matemática/óptica, nunca para afirmação de produto | Jaccard index, circle of confusion, color difference, image histogram |

**Exclusões deliberadas:** listas de "melhores HDRIs", blogs de agência sem data, conteúdo gerado por IA sobre "fotorrealismo em 10 passos", páginas de venda de addons e tutoriais sem versão do Blender. Também excluí números de "qualidade" que não vêm de documentação ou de medição reprodutível.

### 1.4 Como a verificação foi feita

1. **Descoberta** por busca web, priorizando domínios oficiais e repositórios com histórico.
2. **Leitura da fonte** (não só do título): cada afirmação de produto abaixo foi conferida no texto da página ou no README do projeto.
3. **Verificação HTTP** de todas as URLs com `curl -s -o /dev/null -w "%{http_code}" -L --max-time 25`; 60 de 61 retornaram 200 e uma retornou 403 por proteção anti-bot (a página de anúncio do Canvas, da OpenAI), mantida por ser fonte primária real e sinalizada na seção 10.
4. **Execução local:** Blender 5.2.3 LTS (build 2026-10-22) headless, com dois testes descritos na seção 9: corte de janela por boolean em parede de 0,12 m e importação de um asset glTF 1k do próprio repositório.
5. **Leitura do código da v3** para confrontar a documentação com o que o pipeline realmente implementa (`evaluate.py` usa SSIM em blocos 8×8, ΔE00 por pixel e IoU só com máscara).

### 1.5 O que não é possível saber de fora

Esta é a parte que separa pesquisa de marketing. De fora dos laboratórios, **não é possível saber**:

- **Internos dos modelos.** Não há documentação pública da Anthropic ou da OpenAI sobre como o modelo decide chamar uma ferramenta, como pondera descrições de ferramentas, qual o orçamento interno de "pensamento" ou como o pós-treinamento favorece certos padrões de código. Afirmações do tipo "o Claude entende de geometria" ou "o GPT vê profundidade" não são verificáveis.
- **Dados de treino.** Não se sabe se o modelo viu documentação do Blender 4.x, 5.x ou ambas; isso explica parte da deriva de API.
- **Autoria e curadoria de demos.** Um vídeo de MCP de Blender pode ter sido editado, acelerado ou escolhido entre dezenas de tentativas. O README do `blender-mcp` documenta ferramentas, não taxas de sucesso.
- **Comportamento sob carga.** Latência, timeout e limites de contexto em uso real não são públicos; a documentação descreve o contrato, não a distribuição de falhas.
- **Catálogo de assets no instante da execução.** Poly Haven, ambientCG e BlenderKit mudam; contagens e nomes de assets envelhecem.
- **O "look" final.** Nenhuma métrica prova que uma imagem "parece uma foto"; isso envolve percepção humana, repertório e contexto de exibição.

### 1.6 Limites deste documento

O documento é uma síntese de engenharia, não um benchmark. Os limiares da seção 8 vêm do `room-living.json` da v3 e são **pisos de regressão**, não valores universais. O Blender foi executado localmente para validar boolean e importação glTF, **não** para produzir um render fotorrealista completo. Não há promessa de fotorrealismo absoluto em nenhuma seção.

---

## 2. Como o Claude chega ao Blender

### 2.1 Tool use: o contrato, não a mágica

A documentação da Anthropic descreve tool use (também chamado de function calling) como um contrato em que o modelo **não executa nada**: ele devolve uma chamada estruturada, e a aplicação executa. A documentação separa ferramentas de cliente (o seu código roda a operação) de ferramentas de servidor (a Anthropic executa, como busca web e execução de código em sandbox) [1]. Para Blender, o caso é sempre cliente: alguém precisa estar com o Blender aberto e um processo capaz de receber a chamada.

O loop canônico é:

1. a aplicação envia `tools` (nome, descrição, JSON Schema) e a mensagem;
2. o modelo responde com `stop_reason: "tool_use"` e um ou mais blocos `tool_use`;
3. a aplicação executa cada ferramenta e devolve um `tool_result` correlacionado;
4. a conversa é reenviada;
5. repete enquanto houver `tool_use`; para em `end_turn`, `max_tokens`, `stop_sequence` ou recusa.

Consequência prática: cada chamada é **pelo menos um round trip** adicional. Um loop de modelagem com 10 correções custa 10 idas ao modelo, cada uma carregando o histórico (incluindo screenshots). Isso é o principal limitador de custo e de latência — não o render em si [1]. A orientação da Anthropic é começar pelo padrão mais simples que resolve o problema, em vez de montar um framework de agente antes de precisar dele [10].

### 2.2 MCP: o protocolo de descoberta e transporte

O Model Context Protocol (MCP) é um protocolo JSON-RPC entre um **host** (a aplicação de IA, como Claude Desktop ou um agente), um **cliente** por servidor e um **servidor** que expõe contexto. A arquitetura divide o protocolo em camada de dados (primitivas: tools, resources, prompts) e camada de transporte (stdio ou HTTP) [2]. A especificação define o ciclo de vida, as capabilities e as mensagens de `tools/list` e `tools/call` [3].

O ponto que importa para o Director: **MCP não é um renderizador nem um modelo**. É descoberta e chamada. O julgamento visual continua no modelo; o estado da cena continua no servidor/addon. A documentação de segurança do MCP cataloga riscos como *confused deputy*, repasse de tokens e sequestro de sessão [4].

Há dois caminhos para o Claude alcançar um servidor MCP: um cliente local (Claude Desktop/Claude Code inicia o servidor por stdio) ou o **MCP connector** da Messages API, que conecta servidores MCP **remotos** sem você implementar um cliente [5]. O segundo não resolve, sozinho, um Blender atrás de NAT: o servidor precisa estar acessível ou tunelado.

### 2.3 O `blender-mcp` (MCP for Blender) por dentro

O projeto `ahujasid/blender-mcp`, hoje distribuído como **MCP for Blender** (`mcp-for-blender`), tem dois componentes declarados no README [6]:

1. **Addon do Blender** (`addon.py`): cria um servidor de socket TCP dentro do Blender e recebe comandos.
2. **Servidor MCP** (`src/blender_mcp/server.py`): implementa MCP e conversa com o addon.

A configuração padrão é `BLENDER_HOST=localhost` e `BLENDER_PORT=9876`; o protocolo é JSON simples com `type` + `params` e resposta `status` + `result`/`message` [6]. O README é explícito: o socket **não tem autenticação nem criptografia**, e qualquer um que alcance a porta pode rodar Python dentro do Blender; a recomendação é manter em `localhost` ou usar túnel SSH [6].

O README lista nove ferramentas. As relevantes para modelagem:

| Ferramenta | O que faz | Risco/limite |
| --- | --- | --- |
| `execute_blender_code` | Roda Python arbitrário no Blender vivo | Poder total, inclusive destrutivo; o próprio README manda salvar antes [6] |
| `look` | Vê viewport, câmera, ângulos múltiplos, frames; modos `solid`, `material`, `rendered`, `wireframe`, `xray` | É uma imagem 2D; não devolve geometria nem profundidade |
| `get_scene_info` | Resumo compacto da cena, um objeto por linha, com campos selecionáveis | Só o que foi resumido; objeto fora do resumo "não existe" para o modelo |
| `search_assets` / `import_asset` | Busca e importa Poly Haven, Sketchfab, Poly Pizza | Depende de rede e de API de terceiros |
| `generate_3d` | Geração de modelo por Tripo/Hunyuan3D/Hyper3D/Meshy | Custo externo e resultado não determinístico |
| `get_addon_status` | Versão do Blender, do addon e bibliotecas ligadas | Útil para diagnosticar deriva de versão |

O modo `BLENDER_MCP_SAFE_MODE=1` inspeciona o script e bloqueia acesso a arquivos, rede, execução de programas e código persistente; scripts bloqueados voltam ao modelo com o motivo para ele tentar de novo [6]. Isso reduz o risco, mas não é um sandbox de sistema operacional: é uma validação textual antes da execução.

Dois detalhes operacionais do README que explicam falhas reais: downloads de assets acontecem **na thread principal** do Blender, então a UI congela até terminar; e operações complexas "podem precisar ser quebradas em passos menores" [6]. Nada disso é exclusivo do projeto — é a natureza de rodar tudo dentro do processo do Blender.

### 2.4 Executar `bpy`

O modelo normalmente escreve Python. A API do Blender tem dois mundos:

- **`bpy.data`**: o banco de dados do arquivo `.blend` (objetos, malhas, materiais, imagens). Criar um objeto direto em `bpy.data` não depende de contexto e é o caminho preferível para automação [7].
- **`bpy.ops`**: operadores que dependem de contexto (modo, seleção, área, `view_layer`). Funcionam no Blender interativo, mas em headless podem falhar por *poll* ou por contexto ausente; é comum precisar de `temp_override` [7].

Em headless, o padrão é `blender -b -P script.py --python-exit-code 1`, que faz o processo sair com código de erro se o script levantar exceção [9]. No modo interativo (o do `blender-mcp`), o script roda dentro da sessão já aberta: o estado acumula, o undo é do usuário e um erro pode deixar a cena num estado intermediário.

A documentação da API é gerada da versão em uso; nomes de propriedades mudam entre versões (por exemplo, entradas do Principled BSDF e parâmetros de operadores). É a origem mais comum de código "quase certo" que falha na execução.

### 2.5 Ver o resultado: visão

O `look` devolve uma imagem (viewport, câmera, prancha multi-ângulo, frame). O modelo então "vê" um PNG/JPEG. A documentação de visão da Anthropic explica que imagens são redimensionadas conforme a faixa de resolução e que o custo em tokens cresce com o tamanho; há limites por imagem e a API pode reduzir a imagem antes de o modelo vê-la [8].

Isso tem três consequências:

1. **Detalhe fino se perde.** Uma junta de 2 mm, um bevel, uma textura de tecido: se a imagem for reduzida, o modelo não vê.
2. **Cor não é confiável.** A imagem passa por color management, compressão e, às vezes, por captura de viewport com transformação diferente do render final. O modelo pode "corrigir" algo que já estava certo.
3. **Geometria não é vista.** O modelo vê a projeção; não vê a espessura da parede nem se a janela atravessa o volume. Precisa de `get_scene_info` ou de um render de outro ângulo para inferir.

### 2.6 O loop de correção

O loop real é: intenção → plano → código → execução → observação (texto + imagem) → diagnóstico → correção. O modelo é razoável em **primeira aproximação** e fraco em **consistência de estado**: ele lembra do que escreveu, não do que a cena contém. Por isso `get_scene_info` existe; sem ele, o modelo começa a alucinar objetos que já foram apagados ou a recriar materiais com nomes duplicados.

Um padrão que aparece em projetos de agente é o de auto-refinamento: gerar, criticar e reescrever [39]. A diferença no Blender é que a crítica precisa de **evidência externa** (render, métrica, erro do interpretador), não apenas da opinião do modelo sobre o próprio código.

### 2.7 Modos de falha

| Falha | Como se manifesta | Por que acontece | Mitigação no Director |
| --- | --- | --- | --- |
| API inventada | `AttributeError: 'Object' has no attribute ...` | O modelo mistura versões ou "completa" a API por analogia | Schema fechado; validar antes de executar; nunca deixar o modelo escrever `bpy` livre |
| Contexto obsoleto | Objeto some, material duplica, medidas mudam | Estado real ≠ estado no histórico | `get_scene_info` a cada passo; reconstruir a cena a partir do spec |
| Timeout/assíncrono | Comando "enviado" sem resposta; UI travada | Operação longa na thread principal; socket síncrono | Timeout explícito, fila, preview barato, downloads fora do caminho crítico |
| Falta de grounding espacial | Janela "no lugar errado", móvel flutuando | O modelo raciocina em 2D sobre a imagem | Dimensões numéricas + render de verificação + medidas |
| Edição destrutiva | Cena apagada, modificador aplicado sem querer | `execute_blender_code` tem poder total | Sem Python arbitrário; comandos incrementais validados; undo/versionamento |
| Segurança | Porta aberta, script malicioso | Socket sem auth; execução arbitrária | Localhost, safe mode, aprovação humana, nunca expor a porta [6] |
| Deriva de versão | Addon novo em Blender antigo, API renomeada | Versões independentes | `get_addon_status`; pin de versão; testes de fumaça |
| Inchaço de contexto | Loop fica caro e lento; modelo esquece o início | Cada screenshot e cada log voltam ao histórico | Resumos, orçamento de iterações, descartar imagens antigas |
| Não determinismo | Mesmo prompt, cenas diferentes | Amostragem do modelo | Spec determinístico como fonte de verdade |
| Sucesso silencioso | Operador não faz nada e não dá erro | *Poll* falso, contexto errado, nome inexistente | Verificar resultado (contagem, dimensões, render), não só o exit code |

### 2.8 Consequências para a v3

O que o `blender-mcp` demonstra é que **a ponte é fácil; o contrato é difícil**. A v3 não deve copiar o modelo de "Python livre + screenshot": deve usar a lição de que o modelo precisa de ferramentas com descrição e schema, de observação visual e de estado de cena consultável — mas trocando o Python arbitrário por um room plan validado e por um render de verificação com métricas. A seção 8 detalha esse desenho.

---

## 3. Como o ChatGPT/OpenAI faz o equivalente

### 3.1 Function calling

O equivalente da OpenAI chama-se function calling. Você descreve funções com JSON Schema no parâmetro `tools`; o modelo devolve `tool_calls` com nome e argumentos; seu código executa e devolve o resultado com o `call_id` correspondente. O parâmetro `tool_choice` controla o comportamento: `auto` (o modelo decide), `required` (precisa chamar alguma), uma função específica, uma lista permitida ou `none` [11]. O modo estrito (`strict`) valida os argumentos contra o schema, o que reduz — mas não elimina — argumentos inventados [11].

O princípio é idêntico ao da Anthropic: **o modelo não executa**. A diferença é de transporte e de ferramentas disponíveis.

### 3.2 Ferramentas embutidas

A Responses API oferece ferramentas embutidas: busca web, code interpreter, computer use, MCP remoto e outras [12]. O **Code Interpreter** roda Python em um ambiente sandbox da OpenAI, com acesso a arquivos enviados, para análise de dados, código e matemática [13]. Ele **não** alcança o Blender da máquina do usuário: é outro computador, sem a sua cena.

O **computer use** pode operar uma interface gráfica em um ambiente controlado. Em tese, poderia clicar numa UI de Blender se o ambiente tivesse Blender e a sessão fosse exposta; na prática, a documentação consultada descreve o controle de um computador/sandbox, não a viewport do usuário por padrão [12]. É uma diferença de produto, não de capacidade do modelo.

### 3.3 Canvas

O Canvas é uma superfície de edição do produto ChatGPT, anunciada em 2024, voltada a texto e código: o usuário edita o conteúdo lado a lado com o modelo e pode executar código no ambiente do ChatGPT [15]. Ele **não é uma API pública** e **não executa o Blender local**. Um código Python no Canvas roda no sandbox do produto, não no seu `bpy`. Mesmo que o código seja `import bpy`, ele falha por ausência do Blender — e, se houver um Blender no servidor, ele não é o seu.

O status HTTP 403 encontrado na verificação é proteção anti-bot do site da OpenAI, não indisponibilidade da página (ver seção 10).

### 3.4 Custom GPTs e Actions

As **Actions** permitem que um GPT chame uma API externa descrita por um schema OpenAPI, com autenticação configurada [16]. É o mecanismo que, em teoria, permitiria a um GPT controlar um Blender: você expõe um endpoint HTTPS que recebe comandos e executa no seu servidor. O GPT não ganha acesso à sua máquina; ele ganha acesso ao **seu endpoint**. Isso traz de volta todos os problemas de segurança de expor um executor de cena na internet (autenticação, autorização, limites, idempotência).

Não encontrei, na documentação consultada, um produto oficial da OpenAI que abra o Blender local do usuário. O que existe é a infraestrutura (function calling, Actions, MCP) para construir essa ponte.

### 3.5 BlenderGPT: o exemplo do "demo"

O repositório `gd3kr/BlenderGPT` é um addon que coloca um campo de texto no Blender, envia o pedido a um modelo da OpenAI e **executa o Python gerado** [17]. O README é de 2023, fala em acesso ao GPT-4 por waitlist e mostra o fluxo "digite → Execute → código roda". É um protótipo útil e uma prova de conceito, não um produto: não há schema de cena, validação, verificação visual, orçamento de iteração nem tratamento de erro estruturado. O próprio README depende de uma conta e de uma chave do usuário [17].

Esse é o padrão de muitos "Blender + IA": um addon, uma chamada de API, `exec()` do código. Funciona na demonstração e quebra quando a cena cresce.

### 3.6 O que é produto, demo e blog

| Item | Natureza | Evidência | Alcança o Blender local? |
| --- | --- | --- | --- |
| Tool use / function calling | Recurso de API, documentado | [1], [11] | Não por si só; precisa de cliente |
| Code Interpreter | Ferramenta embutida em sandbox | [13] | Não; roda no ambiente da OpenAI |
| Canvas | Superfície de produto | [15] | Não; código no ambiente do ChatGPT |
| Actions | Recurso de GPT, endpoint externo | [16] | Só via endpoint que você expõe |
| `blender-mcp` | Projeto open-source, não oficial | [6] | Sim, com addon local |
| BlenderGPT | Addon comunitário/demo | [17] | Sim, executando código gerado |
| "Claude/ChatGPT modela no Blender" | Demonstração de terceiros | [6], [17] | Depende da ponte, não do modelo |

### 3.7 Conclusão da comparação

Claude e ChatGPT têm o mesmo loop e a mesma limitação estrutural: **o modelo não tem mãos**. O que muda é o cardápio de transporte (MCP, connector, Actions, sandbox). Para a v3, a implicação é que o valor não está em "qual modelo é melhor no Blender", mas em quão fechado é o contrato entre o modelo e o executor. Um schema de sala com dimensões, aberturas, assets e critérios de aceitação vale mais do que qualquer prompt "você é um arquiteto 3D especialista".

---

## 4. O que separa um render "de demonstração" de um render fotorrealista

### 4.1 Escala real

Fotorrealismo começa antes da luz: começa na **escala**. Uma sala com 4,2 m × 5,2 m × 2,75 m tem paredes de 0,12 m, rodapé de 0,10 m, porta de 0,80 m × 2,10 m, janela com peitoril entre 0,90 m e 1,00 m. Se o modelo erra a escala, a luz erra junto: a intensidade cai com o quadrado da distância, o DOF muda, o campo de visão muda.

No Blender, a unidade é configurada em **Scene › Units**: sistema métrico, `Unit Scale = 1.0`, comprimento em metros [18]. Um detalhe que confunde: o `Unit Scale` muda apenas a **exibição** na interface, não o comportamento interno [18]. Para o pipeline, a regra é simples: modelar em metros, com escala 1.0, e nunca "corrigir" escala global depois — corrigir o objeto.

A ferramenta **Measure** mede distâncias e ângulos arrastando linhas na viewport, com snapping à geometria; é útil para conferir espessura de parede e vãos [19]. Em automação, a verificação equivalente é ler `obj.dimensions` e as coordenadas dos vértices, não confiar no olho.

O glTF 2.0 também define metros como unidade linear e +Y como "para cima" [20]. Isso significa que a escala sobrevive à importação, mas a orientação não: o Blender converte para +Z up na importação (ou na exportação, com a opção "Y Up") [48]. Sem conferir, um asset "deitado" parece erro de modelagem quando é convenção de eixo.

### 4.2 PBR correto

O material padrão é o **Principled BSDF**. As entradas que mais afetam o realismo: `Base Color` (albedo), `Metallic`, `Roughness`, `IOR`, `Normal`, além de `Alpha`, `Subsurface`, `Coat`, `Sheen` e `Emission` [21]. O erro clássico é usar `Base Color` como "cor da parede" sem textura e `Roughness` como um número arbitrário: paredes reais têm variação sutil de albedo, rugosidade e normal.

Do lado dos assets, a Poly Haven explica que seus mapas "diffuse" são **albedo** — sem sombreamento embutido — porque o sombreamento deve vir do motor de render e da geometria [22]. Essa é a diferença entre um material PBR e uma textura pintada: o albedo não deve conter sombra, oclusão ou brilho especular "cozidos".

O glTF 2.0 usa o modelo metallic-roughness, com `baseColorTexture`, `metallicRoughnessTexture` e `normalTexture`; os primários de cor são BT.709 [20]. O LearnOpenGL descreve o mesmo modelo e a importância de manter a energia coerente entre difuso e especular [34]; o guia da Marmoset cobre o mesmo princípio na prática [35]. Ao importar, o Blender monta o Principled BSDF; se a textura de rugosidade estiver no canal errado ou com color space errado, o resultado fica "plástico" [48]. Regra prática: mapas de cor em sRGB; rugosidade, metalicidade e normal em Non-Color.

### 4.3 Luz natural e HDRI

A luz de uma sala não é uma lâmpada: é o céu, o sol, o rebote nas paredes e o que entra pela janela. Um **HDRI** é uma imagem equirretangular de 32 bits usada para iluminar a cena; a Poly Haven descreve HDRIs não clipados como os que preservam a faixa inteira de brilho, inclusive o sol, e alerta que um HDRI clipado produz luz "flat" e sem contraste [22]. Todos os assets da Poly Haven são CC0 [23].

No Blender, o mundo (World) usa o HDRI como `Environment Texture`; a força do mundo controla a exposição relativa. O sol é uma luz do tipo `SUN`, com `Strength` em irradiância (W/m²) e `Angle` controlando a suavidade da sombra: quanto maior o ângulo, mais suave. Luzes de área, point e spot usam `Power` em watts [24].

Para uma janela, o rig típico tem três camadas:

1. **HDRI** para o ambiente e reflexos;
2. **sol** (ou luz solar) com ângulo compatível com a hora;
3. **luz de preenchimento** de área na janela, simulando o céu que entra e o rebote.

O `light-rig-presets.json` da v3 codifica exatamente isso: `day` com sol forte e HDRI, `dusk` com sol baixo e quente, `night` com mundo escuro e luminárias internas. A calibração é por **exposição** e por **força relativa**, não por "deixar bonito".

### 4.4 Sombras suaves e contato

Sombras duras são o sinal mais óbvio de render de demo. Na vida real, a luz tem tamanho angular: o sol tem ~0,5°, uma janela é uma fonte extensa, uma lâmpada tem bulbo. Sombras suaves vêm de **fontes extensas** e de **luz indireta**. No Cycles, isso é path tracing: o número de bounces (diffuse, glossy, transmission) determina quanta luz indireta chega às paredes e ao teto [25]; o PBRT formaliza o transporte de luz que o motor aproxima [33]. Poucos bounces = ambiente "morto", com sombras pretas.

Contato é outra pista: todo objeto toca o chão com uma sombra de contato e, muitas vezes, uma pequena oclusão. Um móvel que flutua 1 cm ou que não projeta sombra no carpete parece colado. Não é um problema de shader; é de posicionamento e de luz.

### 4.5 Câmera, DOF e óptica

A câmera do Blender tem `focal length`, `sensor width`, `f-stop` e foco. O DOF é fisicamente baseado na abertura: o `F-Stop` define a quantidade de desfoque; valores menores desfocam mais; o número de lâminas altera a forma do bokeh [26]. A profundidade de campo depende de abertura, distância focal e distância ao assunto — o conceito de **círculo de confusão** formaliza o limite do que parece nítido [27].

Para interiores, a linguagem fotográfica típica é 24–35 mm (full frame), câmera entre 1,4 m e 1,6 m de altura, f/4–f/8 para manter o ambiente legível. Um erro comum é usar 85 mm e f/1.4 "para parecer cinematográfico": em sala pequena, isso comprime a perspectiva e desfoca metade do ambiente. Outro erro é aplicar desfoque no pós: o DOF fisicamente correto tem bokeh e profundidade coerentes com a cena.

### 4.6 Ruído, samples e denoise

Cycles é estocástico: menos samples, mais ruído. O render settings tem `Samples`, `Adaptive Sampling` (para de amostrar quando o ruído estimado cai abaixo de um limiar) e `Denoising` [28]. O denoiser padrão é o OpenImageDenoise (CPU/GPU), com OptiX como alternativa em NVIDIA; o manual recomenda usar pelo menos o passe de albedo, porque denoisar só com cor pode borrar detalhes [28].

O erro de demo é usar 32 samples + denoise agressivo e chamar de final. O denoise esconde o ruído, mas também lava microdetalhe e cria manchas. Para still de interior, o caminho é subir samples até o denoise não precisar "inventar" e usar passes de albedo/normal.

### 4.7 Color management

O color management decide como os valores lineares da cena viram pixels na tela. O Blender oferece `Standard`, `Filmic` e `AgX` (entre outros). O manual descreve `AgX` como o transform que melhora o Filmic e dá resultados mais fotorrealistas, com 16,5 stops de faixa dinâmica e dessaturação de cores muito expostas para imitar a resposta do filme; o `Filmic` está depreciado e foi sucedido pelo AgX [29]. O projeto AgX documenta a motivação e a implementação [30].

Consequências práticas:

- **Não compare render com referência em transforms diferentes.** Um render em `Standard` e uma foto revelada têm curvas diferentes; o ΔE00 vai acusar "erro de cor" que é, na verdade, escolha de view transform.
- **AgX não é "mais bonito"; é um mapeamento de tonemapping.** Ele comprime altas luzes e dessatura o que estoura. Para comparar com uma foto, é preciso saber como a foto foi revelada.
- **Exposição é uma decisão separada.** Mudar `Exposure` no color management é diferente de mudar a potência das luzes; para avaliação, registre a exposição usada.

### 4.8 Imperfeições

O que faz uma imagem "de demo" é a ausência de imperfeição: paredes perfeitamente planas, cantos vivos, materiais uniformes, nada de poeira. No mundo real:

- **Bevels** de 0,5–2 mm quebram a aresta e pegam um fio de luz; o modificador Bevel com `Width` e `Segments` é o caminho barato [31].
- **Tecido** tem sheen, micro-rugosidade e dobras; um sofá de veludo sem variação de normal parece plástico.
- **Sujeira e desgaste** aparecem em rodapés, cantos, carpete e estofado; podem ser textura ou geometria, mas precisam existir.
- **Variação sutil** de albedo e rugosidade por parede evita o "papel de parede digital".
- **Props** (livros, cabos, almofadas, quadro torto) dão escala e vida; mas precisam de contato e sombra.

### 4.9 Composição e linguagem de câmera

Fotorrealismo é também **enquadramento**: a câmera na altura dos olhos, verticais retas, janela não estourada, ponto de fuga coerente com a foto de referência. Uma sala pode ter geometria e luz corretas e ainda parecer "render" porque a câmera está alta, a lente é larga demais ou o horizonte está torto. A referência fotográfica deve ser tratada como **câmera a reproduzir**, não só como "estilo".

### 4.10 Tabela: sinais de demo vs fotorreal

| Sinal | Render de demonstração | Render fotorrealista | Como verificar |
| --- | --- | --- | --- |
| Escala | Medidas "no olho"; móvel gigante | Dimensões em metros conferidas | `obj.dimensions`, Measure [19] |
| Arestas | 90° perfeitos, sem bevel | Micro-bevel com fio de luz | Bevel modifier [31] |
| Material | Cor chapada, roughness constante | Albedo com variação, normal, roughness variável | Principled + texturas [21] |
| Luz | Uma lâmpada, sombra dura | HDRI + sol + preenchimento, sombras suaves | Light rig [22], [24] |
| Indireta | Cantos pretos | Rebote em paredes/teto | Light paths [25] |
| Câmera | Grande-angular alta, tudo nítido | Altura de olho, DOF plausível | Câmera/DOF [26], [27] |
| Ruído | Denoise agressivo, manchas | Samples suficientes, denoise leve | Sampling [28] |
| Cor | Saturação "de render" | AgX/Filmic coerente com a referência | Color management [29] |
| Imperfeição | Nada de poeira, nada torto | Grime, dobras, props | — |
| Composição | Centro, simetria | Linhas e pontos de fuga da foto | — |

---

## 5. Padrões de prompt/instrução que produzem modelagem precisa

### 5.1 Decomposição em passos

Pedir "modele uma sala de estar fotorrealista" é pedir uma caixa de surpresas. O padrão que funciona é decompor em **unidades verificáveis**: casca (paredes/piso/teto), aberturas, mobiliário, materiais, luz, detalhe, avaliação. Cada passo tem entrada, saída e critério de aceitação. A documentação de prompt engineering da Anthropic recomenda clareza, estrutura e exemplos; para tarefas multi-etapa, pedir raciocínio explícito antes da resposta [36]. A OpenAI dá orientação semelhante: instruções específicas, formato de saída definido e decomposição [37].

A literatura de chain-of-thought mostra que modelos melhoram em tarefas de raciocínio quando produzem passos intermediários [38]. Isso não garante precisão geométrica, mas reduz o salto direto "texto → cena".

### 5.2 Dimensões explícitas em metros

Toda dimensão deve ser um número com unidade e tolerância. "Uma sala grande" é ambíguo; "4,20 m × 5,20 m × 2,75 m, paredes de 0,12 m, tolerância ±0,02 m" é verificável. O mesmo vale para aberturas: largura, altura, peitoril, posição ao longo da parede (`u`), espessura do vidro, perfil da esquadria.

Um contrato de exemplo:

```json
{
  "room": {
    "interior": { "width": 4.2, "depth": 5.2, "height": 2.75 },
    "wallThickness": 0.12,
    "walls": [
      {
        "side": "north",
        "openings": [
          { "id": "janela-sala", "type": "window",
            "u": 1.1, "bottom": 0.05, "width": 2.0, "height": 2.2,
            "frame": { "profile": 0.06, "depth": 0.1, "mullions": 1, "transom": 0.35 } }
        ]
      }
    ]
  }
}
```

O schema da v3 (`lib/room.js`) valida exatamente esses campos e rejeita chave desconhecida, material inexistente e janela sem vidro. É a diferença entre "instrução" e "contrato".

### 5.3 Referência visual

Anexar a foto de referência ajuda, mas não basta: o modelo pode descrever a foto em vez de modelar. O padrão é pedir **mapeamento explícito** entre regiões da imagem e geometria:

- "A janela central ocupa de 33% a 67% da largura da imagem e vai do chão ao teto; modele como abertura de 2,0 m × 2,2 m na parede norte, com peitoril 0,05 m."
- "O sofá ocupa o terço esquerdo; é um bloco de 2,1 m × 0,9 m × 0,85 m, encostado na parede oeste."
- "O painel de madeira à direita tem 1,8 m de largura e vai do chão a 2,2 m."

Isso força o modelo a converter pixels em metros e reduz a "alucinação de layout". A referência continua sendo o juiz final da composição, não da geometria.

### 5.4 Critérios de aceitação por região

Em vez de "ficou bom?", defina regiões e critérios:

| Região | Critério | Como medir |
| --- | --- | --- |
| Janela | Vão atravessa a parede; esquadria com 1 montante; vidro com transparência | Ray test; `dimensions`; render |
| Sofá | 2,1 m × 0,9 m × 0,85 m; encostado; sem flutuar | Bounding box; contato |
| Piso | Carpete com rugosidade alta; sem brilho especular | Roughness; render |
| Teto | Sem manchas de denoise; sombra suave | Inspeção; samples |
| Parede | Albedo claro, variação sutil; sem estouro | Histograma; ΔE00 por região |

A avaliação por região é o que evita o clássico "SSIM global razoável, janela errada".

### 5.5 Saída estruturada

Pedir JSON com schema é melhor do que pedir "um plano". A OpenAI documenta **Structured Outputs**, que faz o modelo seguir um JSON Schema (com limites: nem todo schema é suportado) [14]. Na Anthropic, o caminho equivalente é tool use com schema; a ideia é a mesma: o formato é validado pela aplicação, não pela boa vontade do modelo.

Para a v3, o schema deve ter:

- unidades declaradas (`meters`);
- enums para `type` (`window`, `door`), `side` (`north`, `south`, `east`, `west`);
- campos obrigatórios com `minimum`/`maximum`;
- `additionalProperties: false`;
- versão (`schemaVersion`).

### 5.6 Auto-checagem

O padrão Self-Refine mostra que gerar, criticar e revisar melhora a saída em várias tarefas, sem treino adicional [39]. No Blender, a autocrítica precisa ser **ancorada em evidência**: renderizar, medir, comparar com a referência e só então revisar. Um prompt de auto-checagem útil:

> "Antes de responder, verifique: (1) todas as dimensões estão em metros? (2) a soma das aberturas cabe na parede? (3) cada asset importado tem `assetId` e posição? (4) o render usa AgX e exposição registrada? (5) alguma região ficou acima do limiar de ΔE00? Se sim, corrija e re-renderize."

Isso é melhor do que "revise seu trabalho", porque define o que conta como erro.

### 5.7 Restrições

Restrições explícitas são o que separa um pipeline de um chat:

- **"Não produza um render falso."** Se o Blender não estiver disponível, o pipeline deve falhar, não gerar uma imagem sintética.
- **"Importe assets reais."** Nada de modelar à mão o que existe em Poly Haven/ambientCG; registre `assetId` e licença.
- **"Abra as janelas com boolean."** A parede precisa ser uma malha com vão real, não uma textura escura.
- **"Não invente dimensões."** Se a referência não permite medir, marque como estimativa e registre a incerteza.
- **"Não use textura gerada por IA."** Poly Haven declara que seus assets não usam IA generativa [22]; para um resultado defensável, mantenha a provenance.

### 5.8 Anti-padrões

| Anti-padrão | Por que falha | Substituição |
| --- | --- | --- |
| "Sala aconchegante e realista" | Sem métrica, sem escala | Dimensões + materiais + luz + critérios |
| "Use suas habilidades de arquiteto" | Persona não adiciona conhecimento | Schema + referência + tolerâncias |
| "Coloque uma janela bonita" | Ambiente não determina geometria | `u`, `bottom`, `width`, `height` |
| "Ilumine como numa foto" | Subjetivo | Preset `day`/`dusk`/`night` + exposição |
| "Deixe perfeito" | Não acionável | Limiares por região |
| "Corrija o que estiver errado" | O modelo não vê o que você vê | Métricas + regiões + render |
| Prompt gigante com 50 regras | Lost in the middle | Poucas regras, no início e no fim [40] |

### 5.9 Exemplo de prompt completo

```text
Tarefa: construir a sala de estar da referência em anexo no Blender 5.2, em metros.

Contrato:
- Interior 4,20 (largura) × 5,20 (profundidade) × 2,75 (altura); paredes 0,12 m.
- Janela na parede norte: u=1,10, largura 2,00, altura 2,20, peitoril 0,05.
  Recorte por boolean EXACT; esquadria com perfil 0,06, 1 montante, travessa (transom) 0,35; vidro.
- Piso: carpete cinza, roughness 0,96; paredes: branco quente, roughness 0,90.
- Assets: potted_plant_01 (altura 1,25 m, âncora bottom), fancy_picture_frame_01
  (altura 0,72 m, parede leste), modern_ceiling_lamp_01 (teto, escala 1,0).
- Luz: preset "day" (sol 3,2; HDRI sky_day; preenchimento de janela 450 W; lâmpada 18 W).
- Câmera: 28 mm, altura 1,50 m, f/5,6, foco na janela.
- Color management: AgX, exposição 0,0.

Proibições:
- Não gerar imagem por difusão. Se o Blender falhar, retorne erro.
- Não usar textura pintada com sombra no albedo.
- Não inventar medidas; se faltar, marque "estimado".

Entrega:
1) room plan JSON validado; 2) build + render em 1280×854; 3) relatório com
SSIM, ΔE00 global e por região, histograma e IoU (se houver máscara);
4) liste o que não foi possível verificar.
```

### 5.10 Por que isso funciona

- **Reduz ambiguidade** (números em vez de adjetivos).
- **Cria checkpoints** (cada passo tem saída verificável).
- **Ancora a crítica** (métricas e regiões, não gosto pessoal).
- **Limita o dano** (restrições e falha explícita).
- **Mantém o contexto curto** (o schema carrega o contrato; o prompt não precisa repetir tudo).

A ressalva: nenhum prompt compensa um modelo sem visão do resultado. O loop precisa fechar em imagem + métrica.

---

## 6. Pipeline de assets gratuitos

### 6.1 Catálogo e licenças

| Fonte | Conteúdo | Licença | Obrigações | Observações |
| --- | --- | --- | --- | --- |
| Poly Haven | HDRIs, texturas, modelos | CC0 1.0 | Nenhuma; crédito apreciado | Todos os assets são CC0; HDRIs não clipados; mapas "diffuse" são albedo [22], [23], [46] |
| ambientCG | Materiais PBR, alguns modelos | CC0 1.0 | Nenhuma; crédito apreciado | Documentação oficial e API v3 [41], [42] |
| BlenderKit | Modelos, materiais, HDRIs, brushes | Royalty Free ou CC0, por asset | RF permite uso comercial, mas não revender o asset "na mesma forma"; CC0 não impõe restrição [43], [44] | Termos gerais se aplicam [45] |
| CC BY 4.0 (outros) | Modelos diversos | CC BY 4.0 | Atribuição obrigatória [47] | Não confundir com CC0 |

Regra de ouro: **a licença é do asset, não do site**. Poly Haven e ambientCG são CC0 de ponta a ponta; BlenderKit mistura RF e CC0 e separa Free Plan e Full Plan — o plano não muda a licença do asset, que continua sendo RF ou CC0 [43]; um modelo achado em outro lugar pode ser CC BY. O pipeline deve gravar a licença e o autor como custom properties no objeto importado — o `blender-mcp`, por exemplo, grava `polyhaven_id`, `polyhaven_url`, `polyhaven_authors`, `polyhaven_resolution` e `polyhaven_licence` nos assets que importa [6].

### 6.2 Formatos

| Formato | Vantagens | Riscos | Uso recomendado |
| --- | --- | --- | --- |
| `.blend` | Qualidade de autoria; materiais completos; é o formato "fonte" de muitos assets | Depende da versão do Blender; pode trazer dados extras | Preferir para modelos Poly Haven quando disponível [6] |
| `.gltf` / `.glb` | Portável, padronizado, metros, PBR metallic-roughness [20] | Perda de detalhe de material em relação ao `.blend`; texturas separadas no `.gltf` | Preferir para interoperabilidade e para assets leves |
| `.fbx` | Comum em arquitetura/mobiliário | Convenções de eixo e escala variam; menos padronizado | Só quando a fonte só oferece FBX |

O README do `blender-mcp` afirma que, para Poly Haven, o `.blend` é o arquivo que o artista autorou e que as versões glTF/FBX/USD são geradas dele e "perdem detalhe de material" [6]. Isso não é uma lei universal, mas é um bom critério: **se o `.blend` está disponível e a versão do Blender bate, use o `.blend`; caso contrário, glTF**.

### 6.3 Importação em `bpy`

Três caminhos, com semânticas diferentes:

```python
import bpy

# 1) Append de um data-block de um .blend (copia para o arquivo atual)
bpy.ops.wm.append(
    filepath="/assets/sala.blend/Object/Cadeira",
    directory="/assets/sala.blend/Object/",
    filename="Cadeira",
)

# 2) Carregar a biblioteca e linkar objetos (mais controle, sem depender de contexto)
with bpy.data.libraries.load("/assets/sala.blend", link=False) as (src, dst):
    dst.objects = [name for name in src.objects if name.startswith("Cadeira")]

for obj in dst.objects:
    if obj is not None:
        bpy.context.collection.objects.link(obj)

# 3) Importar glTF/glb
bpy.ops.import_scene.gltf(filepath="/assets/planta.gltf")
```

- `bpy.ops.wm.append` copia o data-block do arquivo de biblioteca para o arquivo atual; aceita `link`, `autoselect`, `active_collection` e outros [50].
- `bpy.data.libraries.load` abre a biblioteca e permite escolher o que trazer; é o caminho programático mais estável, porque não depende do contexto de UI [49].
- `bpy.ops.import_scene.gltf` importa a cena glTF, com opções de conversão de eixo e de materiais [51].

Em todos os casos, o importador **não sabe** onde o objeto deve ficar. O pipeline precisa calcular o bounding box, aplicar `fitHeight`/`anchor` e posicionar. A v3 faz isso no `build_room.py`; o teste local (seção 6.7) mostra por que não dá para confiar em `object.location`.

### 6.4 Escala e convenções

- **glTF:** metros, +Y up, +Z forward [20].
- **Blender:** metros (com Unit Scale 1.0), +Z up [18].
- **Importação:** o importador glTF do Blender converte +Y up para +Z up; a opção "Y Up" também aparece na exportação [48].
- **Assets:** muitos vêm com origem no centro geométrico, no pé ou no mundo (0,0,0). O pipeline deve usar o **bounding box** e a âncora declarada (`bottom`, `origin`, `center`), não o `location` bruto.
- **Mobiliário:** alturas típicas — assento 0,42–0,45 m, mesa de centro 0,40–0,45 m, sofá 0,80–0,90 m, porta 2,10 m, bancada 0,90 m.

### 6.5 Armadilhas

| Armadilha | Sintoma | Causa | Correção |
| --- | --- | --- | --- |
| Texturas ausentes | Material rosa/roxo ou cinza | Caminhos relativos quebrados, `.gltf` sem `.bin`/texturas | Empacotar (`File › External Data › Pack`), copiar a pasta inteira, verificar `bpy.data.images` |
| Origem no mundo | Objeto "teleporta" ao posicionar | Todos os objetos do asset com origem (0,0,0) | Calcular bounds; aplicar transform; usar âncora |
| Unidade errada | Asset 100× maior/menor | Fonte em cm ou em polegadas | Conferir `dimensions`; normalizar por altura declarada |
| Polycount alto | Render lento, memória estourada | Modelo de alta densidade sem necessidade | Decimar/LOD; usar 1k/2k de textura para objetos distantes [6] |
| Material complexo | Shader quebrado após importar glTF | Nós fora do escopo metallic-roughness | Reconstruir no Principled; validar mapa por mapa |
| Cor errada | Textura "lavada" ou escura | Color space errado (sRGB vs Non-Color) | Corrigir no Image Texture node |
| Alpha/transparência | Vidro opaco ou folhas com halo | `blend_method`, `alpha` e sombras | Ajustar material e `shadow_method` |
| Download na thread principal | Blender congela | Addon baixa no processo principal [6] | Pré-baixar fora do render; cache local |
| Licença perdida | Asset sem provenance | Metadados não copiados | Gravar `assetId`, autor, licença, URL |

### 6.6 Higiene de licenças e biblioteca

Práticas que evitam dor futura:

1. **Um `assets-library.json`** com `assetId`, fonte, URL, autor, licença, versão, hash e data de download (a v3 já tem esse arquivo).
2. **Custom properties no objeto** (id, fonte, licença, autor), como faz o `blender-mcp` [6].
3. **Pasta por asset**, com texturas ao lado do `.gltf`/`.blend`, para o importador resolver caminhos relativos.
4. **Asset Browser** para bibliotecas locais: catálogos, metadata e arrastar para a cena [52].
5. **Termos da API**: a API pública da Poly Haven tem termos próprios; software que a usa deve deixar claro de onde vêm os assets [53].

### 6.7 O que o teste local mostrou

Importei `potted_plant_01_1k.gltf` (asset do próprio repositório) no Blender 5.2.3 headless. Resultado:

- 4 objetos de malha (`stem`, `pebbles`, `pot`, `leaves`), todos com origem em `(0, 0, 0)`;
- altura total de 0,856 m (haste), 0,531 m (vaso), 0,753 m (folhas) — o asset chega em escala plausível de metros;
- 6 imagens carregadas, 2 materiais (`potted_plant_01_pot`, `potted_plant_01_leaves`);
- as partes se sobrepõem e nenhuma tem origem no pé.

Conclusão prática: **a escala do glTF é confiável; a origem não**. Posicionar pelo `location` do objeto colocaria a planta inteira no centro do mundo. O pipeline precisa de bounds + âncora, exatamente como o `room-living.json` declara (`fitHeight`, `anchor`, `snapToFloor`).

---

## 7. Métodos de avaliação de fidelidade a uma referência

### 7.1 Pré-processamento

Nenhuma métrica é comparável se as imagens não estiverem alinhadas. O mínimo:

1. **Mesma resolução e enquadramento** (ou crop comum).
2. **Mesma exposição e white balance** — ou registrar que foram normalizados, porque normalizar esconde erro.
3. **Máscara de silhueta** quando o fundo não é comparável (janela para exterior, por exemplo).
4. **Regiões de interesse** declaradas antes da medição (para não escolher a região depois de ver o resultado).

O `evaluate.py` da v3 reduz para `maxEvalSize` (512 px) e redimensiona a referência se necessário; isso suaviza detalhes e precisa ser registrado no relatório.

### 7.2 IoU de silhueta

Interseção sobre união:

```text
IoU = |A ∩ B| / |A ∪ B|
```

Quando existe máscara binária (alpha ou máscara separada), o IoU mede o quanto a silhueta do render cobre a da referência. É útil para **layout e enquadramento**: se a janela está deslocada, o IoU cai. É a métrica mais próxima de "geometria projetada" [59].

Limites: ignora textura, cor, detalhe interno, oclusão e profundidade. Duas cenas completamente diferentes podem ter o mesmo IoU se as silhuetas coincidirem. Sem máscara, o `evaluate.py` marca "indisponível" em vez de inventar.

### 7.3 SSIM

O Índice de Similaridade Estrutural compara luminância, contraste e estrutura em janelas locais [54]:

```text
SSIM(x,y) = [(2·μx·μy + C1)(2·σxy + C2)] / [(μx² + μy² + C1)(σx² + σy² + C2)]
C1 = (K1·L)², C2 = (K2·L)², K1 = 0,01, K2 = 0,03
```

Onde `μ` é a média local, `σ` o desvio, `σxy` a covariância e `L` a faixa dinâmica. A implementação de referência usa janela gaussiana 11×11 [54]; a do `scikit-image` tem `win_size` (padrão 7), `data_range` obrigatório para imagens float e opção `gaussian_weights` [55]. A v3 usa uma aproximação em blocos 8×8 sobre a luminância, documentada no cabeçalho do `evaluate.py` — logo, **números da v3 não são diretamente comparáveis com números do scikit-image**.

O que o SSIM mede: similaridade estrutural local. O que ele **não** mede: realismo, plausibilidade física, correção de material. Uma imagem desfocada pode ter SSIM alto contra uma referência desfocada; uma imagem nítida com geometria errada pode ter SSIM baixo. SSIM é sensível a blur, ruído e desalinhamento; é por isso que ele é usado como **piso de regressão**, não como prova de qualidade.

### 7.4 CIEDE2000 (ΔE00)

O ΔE00 mede diferença de cor percebida entre duas cores em CIELAB, com correções de croma (SC), luminosidade (SL) e matiz (SH), além do termo de rotação RT para azuis [56]:

```text
ΔE00 = sqrt( (ΔL'/(kL·SL))² + (ΔC'/(kC·SC))² + (ΔH'/(kH·SH))²
             + RT · (ΔC'/(kC·SC)) · (ΔH'/(kH·SH)) )
```

Com `kL = kC = kH = 1`, é a forma mais comum (e a usada no `evaluate.py`). O paper de Sharma et al. é a referência de implementação, com dados de teste que pegam erros de sinal e de interpolação [56]; o `scikit-image` implementa `deltaE_ciede2000` [57].

O que mede: diferença de cor média por pixel (ou por região). O que **não** mede: se a cor está no lugar certo, se a textura é plausível, se a luz é fisicamente correta. O verbete de diferença de cor resume a escala e a definição de ΔE [60]. E o ponto mais importante para a v3: **ΔE00 depende de exposição, white balance e tone mapping**. Comparar um render AgX com uma foto revelada em outro perfil produz ΔE00 alto mesmo com materiais corretos. Por isso o relatório deve registrar o transform, a exposição e o espaço de cor.

### 7.5 Histograma

O histograma compara a distribuição de intensidade/cor, não a posição dos pixels. A distância L1 normalizada entre histogramas com `N` bins:

```text
d_hist = 1/2 · Σ_b |h_ref(b) − h_render(b)|
```

com `h` normalizado para somar 1; `d_hist` vai de 0 (idênticos) a 1. O `evaluate.py` usa 16 bins RGB e reporta a distância. O verbete de histograma de imagem serve como definição geral [61].

O que mede: distribuição global de tons. O que não mede: layout, geometria, textura. Duas cenas diferentes — uma sala clara e uma parede clara — podem ter histogramas quase iguais. É útil como **detector de desvio global** (render escuro/claro demais, saturation demais), não como prova de fidelidade.

### 7.6 Comparação por regiões

Métricas globais escondem erro local. A v3 define regiões (`janela`, `sofa`, `midia`, `piso`, `teto`) com retângulos normalizados e calcula ΔE00 e SSIM por região; o gate usa o **pior** ΔE00 de região, não a média. Isso é mais honesto: uma janela errada não é compensada por um piso perfeito.

Cuidados: a região precisa existir nas duas imagens; se o enquadramento muda, a região deixa de corresponder. E a escolha das regiões não pode ser feita depois de ver o resultado (data leakage).

### 7.7 O que cada métrica não prova

| Métrica | Mede | Não prova | Falha típica |
| --- | --- | --- | --- |
| IoU | Sobreposição de silhueta | Textura, cor, detalhe interno, profundidade | Silhuetas iguais, cenas diferentes |
| SSIM | Similaridade estrutural local | Realismo, física, material | Desfoque/ruído/desalinhamento dominam |
| ΔE00 | Diferença de cor percebida | Posição, textura, luz correta | Exposição/tone mapping mudam o resultado |
| Histograma | Distribuição de tons | Layout, geometria, materiais | Cenas diferentes, histograma igual |
| Regiões | Erro local | Correção global | Região mal escolhida ou desalinhada |
| LPIPS | Distância perceptual aprendida | Realismo físico | Pode ser "enganado" por textura |

**Nenhuma delas prova fotorrealismo.** Fotorrealismo é uma afirmação sobre a resposta perceptual humana a uma imagem; métricas de similaridade medem outra coisa. O máximo que se pode dizer é: "o render está próximo da referência sob estas condições e passou nestes pisos".

### 7.8 LPIPS e alternativas perceptuais

LPIPS usa features de redes profundas para medir distância perceptual e se aproxima mais do julgamento humano do que PSNR/SSIM em vários benchmarks [58]. Mas: (a) depende de uma rede e de pesos; (b) foi treinado em outro domínio; (c) não mede plausibilidade física; (d) pode preferir imagens "bonitas" a imagens corretas. Para a v3, LPIPS é um complemento, não um substituto dos gates geométricos.

### 7.9 Protocolo de referência

Para que a comparação signifique algo:

1. **Fotografe ou escolha a referência** com a mesma lente/altura de câmera que o render vai usar (ou registre a diferença).
2. **Trave exposição e white balance**; se a foto for HDR, registre o merge.
3. **Recorte** para a mesma proporção; gere a máscara de silhueta.
4. **Declare as regiões** antes de renderizar.
5. **Registre** transform de cor, exposição, samples, denoise, versão do Blender.
6. **Rode as métricas** e leia o relatório; não escolha o número que agrada.

---

## 8. Síntese para o pipeline v3

### 8.1 Sequência recomendada

A ordem abaixo é a do contrato da v3: cada etapa produz um artefato verificável e só passa para a seguinte se o gate anterior fechar.

```text
referência + calibração
        │
        ▼
[1] graybox medido  ──► gates G0–G1 (escala, watertight, aberturas)
        │
        ▼
[2] assets          ──► gate G2 (assetId, bounds, âncora, licença)
        │
        ▼
[3] materiais base  ──► gate G3 (PBR, texturas, color space)
        │
        ▼
[4] light rig       ──► gate G4 (exposição, clipping, sombras)
        │
        ▼
[5] detalhe         ──► gate G5 (bevels, props, contato, imperfeições)
        │
        ▼
[6] avaliação + iteração ──► gates G6–G7 (métricas, orçamento, humano)
```

Observação honesta: na prática, luz e material se ajustam juntos; a ordem é um contrato de **não avançar sem verificar**, não uma lei física. O importante é que a luz não seja usada para esconder geometria errada.

### 8.2 Gates

| Gate | Critério | Ferramenta | Falha → ação |
| --- | --- | --- | --- |
| G0 — escala | Dimensões dentro de ±0,02 m; paredes watertight; aberturas contadas | `build_room.py`, ray test, `bmesh` | Corrigir planta; não seguir |
| G1 — aberturas | Vão atravessa a parede; esquadria e vidro presentes; sem z-fighting | Boolean EXACT + ray test | Reaplicar boolean; conferir `u/bottom/width/height` |
| G2 — assets | Todo asset tem `assetId`, bounds, âncora e licença; sem textura ausente | `assets-library.json`, `bpy.data.images` | Reimportar; corrigir caminho; trocar asset |
| G3 — materiais | Principled com albedo/roughness/normal; mapas em color space correto | Inspeção de nós + render | Corrigir textura; refazer material |
| G4 — luz | Sem clipping; exposição registrada; sombras suaves; preset correto | Render + histograma | Ajustar sol/HDRI/preenchimento |
| G5 — detalhe | Sem objeto flutuando; bevels; props com contato | Render + bounds | Corrigir posição/bevel |
| G6 — avaliação | SSIM ≥ 0,50; ΔE00 ≤ 20; ΔE00 região ≤ 30; hist ≤ 0,30; IoU ≥ 0,60 (se máscara) | `evaluate.py` | Diagnosticar por região (8.6) |
| G7 — humano | Composição, estilo, imperfeição aceitável, licença | Revisão humana | Aprovar ou pedir ajuste |

Os limiares de G6 vêm do `room-living.json` da v3. O próprio arquivo os descreve como "piso de regressão, não prova de fotorrealismo". Eles não foram calibrados contra um corpus; são um ponto de partida para um par específico (foto × render) e devem ser recalculados se a referência, a câmera ou o transform mudarem.

### 8.3 Limiares configurados (estado atual)

| Métrica | Limiar | O que significa | O que não significa |
| --- | --- | --- | --- |
| SSIM | ≥ 0,50 | Estrutura global minimamente parecida | Qualidade visual |
| ΔE00 global | ≤ 20 | Cor média próxima | Cor correta por objeto |
| ΔE00 pior região | ≤ 30 | Nenhuma região grosseiramente errada | Todas as regiões boas |
| Histograma | ≤ 0,30 | Distribuição de tons próxima | Layout correto |
| IoU | ≥ 0,60 | Silhueta razoavelmente alinhada | Textura/detalhe |

Um SSIM de 0,50 é baixo para padrões de compressão de imagem; para foto × render com assets diferentes, pode ser um piso realista. O ponto é **não chamar isso de fotorrealismo**: é regressão.

### 8.4 Orçamento de iteração

- **Geometria:** 1–2 correções; se não fechar, o problema é a planta/referência, não o modelo.
- **Materiais:** 2–3 iterações; comparar com a região, não com o global.
- **Luz:** 2–3 iterações; mudar uma variável por vez (sol, HDRI, preenchimento, exposição).
- **Detalhe:** 1–2 iterações; parar quando o ganho de métrica for menor que o custo.
- **Total:** ~8 renders por job; se estourar, revisar o plano, não insistir.

### 8.5 Fronteira de revisão humana

Humano decide:

- se a composição "lê" como a referência;
- se o estilo dos móveis é aceitável;
- se uma imperfeição é charmosa ou um erro;
- se a licença do asset é compatível com o uso;
- se o render final pode ser entregue como "fotorrealista" (o pipeline não faz essa afirmação sozinho).

Máquina decide:

- escala, watertight, aberturas;
- presença de texturas e color space;
- métricas e gates;
- regressão (o render piorou?).

### 8.6 Diagnóstico por métrica

| Sintoma | Hipótese | Onde olhar |
| --- | --- | --- |
| SSIM baixo, ΔE00 ok | Geometria/enquadramento errado | IoU, overlay, câmera |
| SSIM ok, ΔE00 alto | Cor/exposição/tone mapping | Color management, luz, albedo |
| ΔE00 alto em uma região | Material/local light errado | Região, textura, luz |
| Histograma longe | Exposição global ou saturation | Exposure, AgX, world strength |
| IoU baixo | Silhueta/câmera/layout | Máscara, câmera, posição |
| Todos ok, visual ruim | Textura/imperfeição/composição | Revisão humana |

### 8.7 Pseudo-loop

```python
for step in ["graybox", "openings", "assets", "materials", "light", "detail"]:
    scene = build(step, plan)
    render = render_preview(scene)
    report = evaluate(render, reference, regions, thresholds)
    if not report.gates[step].ok:
        plan = repair(plan, report.diagnosis)
        continue
    if step == "detail":
        break
```

O loop não é "o modelo olha e melhora"; é "o pipeline mede e o modelo corrige o que a medida aponta". Essa é a diferença entre um agente e um gerador de imagens.

---

## 9. O que foi verificado / o que não foi

### 9.1 Verificado em fonte primária

- O contrato de tool use da Anthropic: ferramentas de cliente vs servidor, loop com `tool_use`/`tool_result`, round trips [1].
- A arquitetura MCP (host/cliente/servidor, camadas, primitivas) e as recomendações de segurança [2]–[4]; a existência do MCP connector para servidores remotos [5].
- O `blender-mcp`: dois componentes, socket TCP 9876, JSON `type/params` → `status/result`, nove ferramentas, `execute_blender_code`, `look`, `get_scene_info`, safe mode, ausência de auth, freeze em downloads [6].
- A API `bpy` (data vs ops, headless, exit code) [7], [9].
- A visão da Anthropic: imagens são redimensionadas e custam tokens conforme o tamanho [8].
- Function calling, `tool_choice`, strict, code interpreter em sandbox, Canvas, Actions, BlenderGPT [11]–[17].
- Unidades métricas e Unit Scale, Measure, boolean EXACT, Principled BSDF, luzes, light paths, câmera/DOF, sampling/denoise, color management (AgX/Filmic), bevel, glTF [18]–[31], [48].
- Licenças CC0 da Poly Haven e ambientCG, duas licenças do BlenderKit e CC0/CC BY [22], [23], [41]–[47]; fórmulas e implementações de IoU, SSIM, ΔE00, histograma e LPIPS [54]–[61].

### 9.2 Verificado localmente

O Blender 5.2.3 LTS foi executado em modo headless (build 2026-10-22) para validar os mecanismos dos quais o pipeline depende — não o pipeline inteiro:

1. **Boolean de janela:** parede de 4,44 × 0,12 × 2,75 m; corte de 2,00 × 2,20 m com `solver='EXACT'`. Resultado: dimensões externas preservadas, 16 vértices e 12 faces, **0 arestas non-manifold**; um raio pelo centro da janela **não** encontra a parede, enquanto um raio ao lado encontra a face externa em `y = -2,72`. Isso confirma que o vão atravessa a parede e que o resultado permanece watertight.
2. **Importação glTF:** `potted_plant_01_1k.gltf` importado com 4 malhas, altura de 0,856 m, 6 imagens e origens em `(0,0,0)` — confirmando a armadilha de origem e a escala em metros.
3. **Leitura do `evaluate.py`:** SSIM em blocos 8×8, ΔE00 por pixel, histograma de 16 bins, IoU só com máscara; limiares obrigatórios.
4. **Verificação HTTP:** 60 URLs com 200; 1 com 403 (Canvas, OpenAI).

### 9.3 Secundário / comunidade

- O comportamento do `blender-mcp` foi lido no README do projeto, não auditado linha a linha; taxas de sucesso e falhas em uso real não são públicas.
- A thread do BlenderArtists sobre imagens "que não parecem realistas" é experiência de comunidade, não estudo controlado [32].
- LearnOpenGL, Marmoset e PBRT são referência técnica, não benchmark [33]–[35]; os verbetes de Jaccard, cor e histograma são definições, não afirmações de produto [59]–[61].

### 9.4 Não verificado

- **Internos dos modelos** (Anthropic/OpenAI): política de seleção de ferramentas, treino, limites reais, causas de alucinação de API.
- **Canvas da OpenAI:** a página oficial retornou 403 ao curl; a descrição acima se baseia no anúncio público e na documentação de produto, não em teste do Canvas.
- **Validade preditiva dos limiares:** não há corpus; os números são piso de regressão.
- **Fotorrealismo absoluto:** não é demonstrável por este documento nem por essas métricas.
- **Desempenho em GPU/tempo de render:** não medido nesta máquina; o catálogo de Poly Haven, ambientCG e BlenderKit também muda com o tempo.
- **Pipeline completo:** não rodei um render final da sala nem a comparação real contra a referência; o gate G6 (SSIM/ΔE00/IoU) não foi exercitado neste documento. Os números da seção 8 são do contrato, não de uma medição desta pesquisa.

### 9.5 O que este documento não promete

Não promete que o Blender Director v3 vai produzir uma imagem indistinguível de uma foto. Promete um caminho verificável: geometria em metros, aberturas reais, assets licenciados, luz plausível, color management consistente e métricas com limites declarados. Se o resultado final "parece uma foto" é uma decisão humana — e continua sendo.

## 10. Fontes

Todas as URLs foram verificadas em **2026-11-04** com `curl -L`; a marcação "HTTP" registra o código observado. Onde a página bloqueia bots (403), o conteúdo foi conferido por outras fontes primárias e a limitação está anotada.

### 10.1 Anthropic, MCP e agentes

1. Anthropic. *Tool use with Claude* (Claude Platform Docs). 2026. https://docs.claude.com/en/docs/agents-and-tools/tool-use/overview — HTTP 200.
2. Model Context Protocol. *Architecture overview*. 2026. https://modelcontextprotocol.io/docs/learn/architecture — HTTP 200.
3. Model Context Protocol. *Specification 2025-06-18*. 2025. https://modelcontextprotocol.io/specification/2025-06-18 — HTTP 200.
4. Model Context Protocol. *Security Best Practices* (spec 2025-06-18). 2025. https://modelcontextprotocol.io/specification/2025-06-18/basic/security_best_practices — HTTP 200.
5. Anthropic. *MCP connector* (Claude Platform Docs). 2026. https://platform.claude.com/docs/en/agents-and-tools/mcp-connector.md — HTTP 200.
6. Ahuja, S. *MCP for Blender (blender-mcp)*. GitHub. 2025–2026. https://github.com/ahujasid/blender-mcp — HTTP 200.
7. Blender Foundation. *Blender Python API* (current). 2026. https://docs.blender.org/api/current/ — HTTP 200.
8. Anthropic. *Images and vision*. 2026. https://docs.claude.com/en/docs/build-with-claude/vision — HTTP 200.
9. Blender Foundation. *Command Line Arguments* (Blender 5.2 LTS Manual). 2026. https://docs.blender.org/manual/en/latest/advanced/command_line/arguments.html — HTTP 200.
10. Anthropic. *Building effective agents*. 2024. https://www.anthropic.com/engineering/building-effective-agents — HTTP 200.

### 10.2 OpenAI e ChatGPT

11. OpenAI. *Function calling*. 2026. https://platform.openai.com/docs/guides/function-calling — HTTP 200.
12. OpenAI. *Tools* (built-in tools). 2026. https://platform.openai.com/docs/guides/tools — HTTP 200.
13. OpenAI. *Code Interpreter*. 2026. https://platform.openai.com/docs/guides/tools-code-interpreter — HTTP 200.
14. OpenAI. *Structured outputs*. 2026. https://platform.openai.com/docs/guides/structured-outputs — HTTP 200.
15. OpenAI. *Introducing Canvas*. 2024. https://openai.com/index/introducing-canvas/ — **HTTP 403** (proteção anti-bot; página oficial real, conteúdo não acessível por curl).
16. OpenAI. *Actions*. 2026. https://platform.openai.com/docs/actions/introduction — HTTP 200.
17. gd3kr. *BlenderGPT*. GitHub. 2023. https://github.com/gd3kr/BlenderGPT — HTTP 200.

### 10.3 Blender: escala, modelagem, luz, câmera e render

18. Blender Foundation. *Scene › Units* (Blender 5.2 LTS Manual). 2026. https://docs.blender.org/manual/en/latest/scene_layout/scene/properties.html — HTTP 200.
19. Blender Foundation. *Measure* (Blender 5.2 LTS Manual). 2026. https://docs.blender.org/manual/en/latest/editors/3dview/toolbar/measure.html — HTTP 200.
20. Khronos Group. *glTF 2.0 Specification*. s.d. (v2.0). https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html — HTTP 200.
21. Blender Foundation. *Principled BSDF* (Blender 5.2 LTS Manual). 2026. https://docs.blender.org/manual/en/latest/render/shader_nodes/shader/principled.html — HTTP 200.
22. Poly Haven. *FAQ* (Poly Haven Wiki). s.d. https://docs.polyhaven.com/en/faq — HTTP 200.
23. Poly Haven. *License*. s.d. https://polyhaven.com/license — HTTP 200.
24. Blender Foundation. *Light Objects* (Blender 5.2 LTS Manual). 2026. https://docs.blender.org/manual/en/latest/render/lights/light_object.html — HTTP 200.
25. Blender Foundation. *Light Paths* (Blender 5.2 LTS Manual). 2026. https://docs.blender.org/manual/en/latest/render/cycles/render_settings/light_paths.html — HTTP 200.
26. Blender Foundation. *Cameras* (Blender 5.2 LTS Manual). 2026. https://docs.blender.org/manual/en/latest/render/cameras.html — HTTP 200.
27. Wikipedia. *Circle of confusion*. 2026. https://en.wikipedia.org/wiki/Circle_of_confusion — HTTP 200.
28. Blender Foundation. *Render Settings › Sampling* (Blender 5.2 LTS Manual). 2026. https://docs.blender.org/manual/en/latest/render/cycles/render_settings/sampling.html — HTTP 200.
29. Blender Foundation. *Color Management* (Blender 4.5 Manual). 2025. https://docs.blender.org/manual/en/4.5/render/color_management.html — HTTP 200.
30. Sobotka, T. *AgX*. GitHub. 2023–2026. https://github.com/sobotka/AgX — HTTP 200.
31. Blender Foundation. *Bevel Modifier* (Blender 5.2 LTS Manual). 2026. https://docs.blender.org/manual/en/latest/modeling/modifiers/generate/bevel.html — HTTP 200.
32. Blender Artists Community. *Why my images don't look realistic?* (thread). 2024. https://blenderartists.org/t/why-my-images-dont-look-realistic/1619224 — HTTP 200.
33. Pharr, M.; Jakob, W.; Humphreys, G. *Physically Based Rendering: From Theory to Implementation* (online edition). 2023. https://pbr-book.org/ — HTTP 200.
34. LearnOpenGL. *PBR Theory*. s.d. https://learnopengl.com/PBR/Theory — HTTP 200.
35. Marmoset. *Physically Based Rendering: And You Can Too*. s.d. https://marmoset.co/posts/physically-based-rendering-and-you-can-too/ — HTTP 200.

### 10.4 Instruções e prompting

36. Anthropic. *Prompt engineering overview*. 2026. https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/overview — HTTP 200.
37. OpenAI. *Prompt engineering*. 2026. https://platform.openai.com/docs/guides/prompt-engineering — HTTP 200.
38. Wei, J. et al. *Chain-of-Thought Prompting Elicits Reasoning in Large Language Models*. arXiv:2201.11903. 2022. https://arxiv.org/abs/2201.11903 — HTTP 200.
39. Madaan, A. et al. *Self-Refine: Iterative Refinement with Self-Feedback*. arXiv:2303.17651. 2023. https://arxiv.org/abs/2303.17651 — HTTP 200.
40. Liu, N. F. et al. *Lost in the Middle: How Language Models Use Long Contexts*. arXiv:2307.03172. 2023. https://arxiv.org/abs/2307.03172 — HTTP 200.

### 10.5 Assets, licenças e formatos

41. ambientCG. *License*. s.d. https://ambientcg.com/license — HTTP 200.
42. ambientCG. *Documentation*. s.d. https://docs.ambientcg.com/ — HTTP 200.
43. Blendkit (BlenderKit). *Licenses*. 2026. https://www.blenderkit.com/docs/licenses/ — HTTP 200.
44. Blendkit (BlenderKit). *Licensing FAQ*. 2026. https://www.blenderkit.com/docs/licenses/licensing-faq/ — HTTP 200.
45. Blendkit (BlenderKit). *Terms and Conditions*. 2021. https://www.blenderkit.com/terms-and-conditions-2021/ — HTTP 200.
46. Creative Commons. *CC0 1.0 Universal*. s.d. https://creativecommons.org/publicdomain/zero/1.0/ — HTTP 200.
47. Creative Commons. *Attribution 4.0 International*. s.d. https://creativecommons.org/licenses/by/4.0/ — HTTP 200.
48. Blender Foundation. *glTF 2.0* (Blender 4.5 Manual). 2025. https://docs.blender.org/manual/en/4.5/addons/import_export/scene_gltf2.html — HTTP 200.
49. Blender Foundation. *bpy.types.BlendDataLibraries*. 2026. https://docs.blender.org/api/current/bpy.types.BlendDataLibraries.html — HTTP 200.
50. Blender Foundation. *bpy.ops.wm* (append). 2026. https://docs.blender.org/api/current/bpy.ops.wm.html — HTTP 200.
51. Blender Foundation. *bpy.ops.import_scene* (glTF). 2026. https://docs.blender.org/api/current/bpy.ops.import_scene.html — HTTP 200.
52. Blender Foundation. *Asset Browser* (Blender 5.2 LTS Manual). 2026. https://docs.blender.org/manual/en/latest/editors/asset_browser.html — HTTP 200.
53. Poly Haven. *Public API — Terms of Service*. GitHub. s.d. https://github.com/Poly-Haven/Public-API/blob/master/ToS.md — HTTP 200.

### 10.6 Métricas de imagem

54. Wang, Z.; Bovik, A. C.; Sheikh, H. R.; Simoncelli, E. P. *Image quality assessment: from error visibility to structural similarity*. IEEE Transactions on Image Processing, 13(4), 2004. https://ece.uwaterloo.ca/~z70wang/publications/ssim.pdf — HTTP 200.
55. scikit-image. *Metrics — structural_similarity*. 2026. https://scikit-image.org/docs/stable/api/skimage.metrics.html — HTTP 200.
56. Sharma, G.; Wu, W.; Dalal, E. N. *The CIEDE2000 color-difference formula: implementation notes, supplementary test data, and mathematical observations*. Color Research & Application, 30(1), 2005. https://www.ece.rochester.edu/~gsharma/ciede2000/ciede2000noteCRNA.pdf — HTTP 200.
57. scikit-image. *Color — deltaE_ciede2000*. 2026. https://scikit-image.org/docs/stable/api/skimage.color.html — HTTP 200.
58. Zhang, R.; Isola, P.; Efros, A. A.; Shechtman, E.; Wang, O. *The Unreasonable Effectiveness of Deep Features as a Perceptual Metric*. CVPR 2018. https://arxiv.org/abs/1801.03924 — HTTP 200.
59. Wikipedia. *Jaccard index*. 2026. https://en.wikipedia.org/wiki/Jaccard_index — HTTP 200.
60. Wikipedia. *Color difference*. 2026. https://en.wikipedia.org/wiki/Color_difference — HTTP 200.
61. Wikipedia. *Image histogram*. 2026. https://en.wikipedia.org/wiki/Image_histogram — HTTP 200.

---

**Nota final:** este documento é pesquisa, não especificação de produto. As decisões de engenharia da v3 estão em `spec-blender-director-v2.md` (base) e nos artefatos `build_room.py`/`evaluate.py`; onde este texto divergir do código, o código é a fonte de verdade.
