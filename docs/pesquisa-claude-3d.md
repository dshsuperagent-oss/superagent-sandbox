# Como Claude e ChatGPT conduzem modelagem 3D

**Processo, evidência primária e tradução para o pipeline do Blender Director v3**

| Campo | Valor |
| --- | --- |
| Data da pesquisa | 2026-11-04 |
| Escopo | O **processo** pelo qual Claude (Anthropic) e ChatGPT/OpenAI chegam a uma cena 3D — não um catálogo de plugins. |
| Corpus | 38 fontes: documentação Anthropic e OpenAI, 13 papers (arXiv/IJCV/IEEE), documentação e API do Blender, 2 repositórios oficiais de sistemas relevantes. |
| Regra de evidência | Toda afirmação não trivial tem fonte numerada, trecho citado (≤ 40 palavras) e link. O que não foi verificado está declarado como tal. |
| Verificação de URLs | `curl -s -o /dev/null -w "%{http_code}" -L --max-time 20` em 2026-11-04. Todos 2xx/3xx, exceto o original do Canvas (403; cópia arquivada 200, ver fonte 16). |

> **Resumo em uma frase:** o modelo não "abre o Blender" nem "enxerga a cena 3D"; ele emite chamadas de ferramenta estruturadas (ou código) que um aplicativo executa, recebe de volta texto/JSON/imagens e repete. Todo o cálculo geométrico e toda a validação determinística acontecem **fora** do modelo.

## Sumário

1. [O que está documentado — e o que não está](#1-o-que-está-documentado--e-o-que-não-está)
2. [O loop real: contrato de ferramenta, execução e observação](#2-o-loop-real-contrato-de-ferramenta-execução-e-observação)
3. [Método reproduzível, passo a passo](#3-método-reproduzível-passo-a-passo)
4. [Onde o método falha](#4-onde-o-método-falha)
5. [O que é folclore](#5-o-que-é-folclore)
6. [Tradução para o pipeline deste repositório](#6-tradução-para-o-pipeline-deste-repositório)
7. [As três perguntas](#7-as-três-perguntas)
8. [Fontes](#8-fontes)
9. [Apêndice — checklist operacional](#9-apêndice--checklist-operacional)

---

## 1. O que está documentado — e o que não está

### 1.1 Não existe "modo 3D" no modelo

Nenhuma das fontes primárias consultadas descreve uma ferramenta de modelagem 3D embutida no modelo. O que a Anthropic documenta é um contrato: o modelo devolve um bloco `tool_use`; o **seu** código executa e devolve um `tool_result`.

> "Claude responds with `stop_reason: "tool_use"` and one or more `tool_use` blocks." — [Anthropic, *Tool use with Claude*][1] `[verificado]`

A OpenAI documenta o mesmo contrato com outro nome e outro formato: o modelo devolve um `function_call`; a aplicação executa.

> "Execute code on the application side with input from the tool call" — [OpenAI, *Function calling*][11] `[verificado]`

A consequência é arquitetural, não uma preferência de produto: **o kernel geométrico (Blender, FreeCAD, um renderizador) está sempre no lado da aplicação**. O modelo só vê o que a ferramenta devolve. `[inferido]` a partir de [1][11]; nenhuma fonte afirma que o modelo tenha um kernel 3D interno.

### 1.2 O que o modelo observa

O servidor MCP de Blender mais usado descreve exatamente o que volta para o modelo: código executado, um resumo compacto da cena e imagens sob demanda.

> "The AI writes Blender Python itself for modelling, layout, materials, animation, rigging and retopology." — [ahujasid, *mcp-for-blender*][37] `[verificado]`

> "Multi-angle, camera, wireframe, X-ray and animation-strip views, plus renders, so the AI checks its own work" — [ahujasid, *mcp-for-blender*][37] `[verificado]`

Ou seja: o modelo recebe **texto, JSON e PNG**, não malha, não transformadas, não interseções. A "compreensão espacial" dele é a que consegue reconstruir desses artefatos. `[inferido]`

### 1.3 O limite da leitura de imagem

A documentação de visão da Anthropic é explícita sobre o que a imagem permite e onde erra.

> "Claude might hallucinate or make mistakes when interpreting low-quality, rotated, or very small images under 200 pixels." — [Anthropic, *Vision*][4] `[verificado]`

E a documentação de coordenadas avisa que a precisão depende de o pedido declarar o formato e de conferência visual humana.

> "Coordinate accuracy is best when you state the expected coordinate format in your prompt and spot-check results visually before processing at scale." — [Anthropic, *Coordinates and bounding boxes*][5] `[verificado]`

> "The detail parameter controls image preprocessing." — [OpenAI, *Images and vision*][14] `[verificado]`

Ou seja, a imagem que o modelo recebe já passou por redimensionamento e recorte; detalhe fino pode desaparecer antes de qualquer raciocínio. `[inferido]`

Nada nessa documentação promete **metros**, intrinsics de câmera ou reconstrução métrica. Isso é um problema separado, tratado por metrologia de vista única e calibração de câmera (seções 3.1 e 3.2). `[verificado]` para a ausência de promessa; `[inferido]` para a necessidade de um método externo.

---

## 2. O loop real: contrato de ferramenta, execução e observação

### 2.1 O contrato, lado a lado

| Etapa | Anthropic (tool use) | OpenAI (function calling) |
| --- | --- | --- |
| Declarar | `tools` com `input_schema` (JSON Schema) | `tools` com JSON Schema |
| Modelo decide | `stop_reason: "tool_use"` + bloco `tool_use` [1] | `function_call` / tool call [11] |
| Aplicação executa | "Your code runs the operation" [1] | "Execute code on the application side" [11] |
| Resultado volta | `tool_result` [1] | output com `call_id` [11] |
| Repetir | enquanto `stop_reason == "tool_use"` [1] | "as many tool calls as the task requires" [11] |

O ponto que importa para 3D: **cada passo é uma ida e volta**. O modelo não tem estado privilegiado da cena; ele reconstrói o estado a partir do histórico de resultados. `[inferido]` a partir de [1][11].

### 2.2 MCP não é um "entendimento 3D", é transporte

MCP padroniza descoberta e chamada de ferramentas. A Anthropic o apresenta como padrão de conexão, não como representação de cena.

> "It provides a universal, open standard for connecting AI systems with data sources" — [Anthropic, *Introducing the Model Context Protocol*][3] `[verificado]`

O conector MCP da API permite falar com servidores remotos sem escrever um cliente MCP:

> "Connect to remote MCP servers directly from the Messages API without an MCP client" — [Anthropic, *MCP connector*][2] `[verificado]`

Para Blender, o servidor expõe ferramentas como `execute_blender_code`, `look` e `get_scene_info`, e o addon roda **dentro** do Blender, num socket. [37] `[verificado]` O protocolo não acrescenta geometria: ele apenas transporta a chamada e a imagem de volta. `[inferido]`

### 2.3 ChatGPT/OpenAI: mesmo loop, superfícies diferentes

A OpenAI tem três superfícies que costumam ser confundidas com "3D":

1. **Function calling** — o modelo pede uma função; seu código executa. É o caminho para um addon/socket local. [11] `[verificado]`
2. **Code Interpreter** — Python em sandbox da OpenAI, não no Blender da sua máquina: "allows models to write and run Python code in a sandboxed environment" [13] `[verificado]`.
3. **Canvas** — superfície de escrita/código do produto ChatGPT: "The model knows when to open a canvas, make targeted edits, and fully rewrite." [16] `[verificado]` (cópia arquivada; o original responde 403 a clientes automatizados).

O Canvas é útil para editar *código* que gera uma cena, mas não é uma API de Blender. `[inferido]` — a fonte [16] descreve escrita e código, não execução 3D.

### 2.4 Structured outputs: o que garante e o que não garante

Quando o modelo emite uma spec em vez de código, a garantia é sintática.

> "Structured Outputs is a feature that ensures the model will always generate responses that adhere to your supplied JSON Schema" — [OpenAI, *Structured model outputs*][12] `[verificado]`

Garantir o schema **não** garante que a cena seja fisicamente válida, que a câmera esteja dentro da sala ou que os móveis não se interpenetrem. Essa é a razão de existir um portão determinístico como o `validate.py` deste repositório. `[inferido]`

---

## 3. Método reproduzível, passo a passo

O método abaixo é a reconstrução do processo que as fontes **permitem** e que o pipeline implementa. Onde a fonte é uma inferência de engenharia, está marcado. A ordem não é um ritual: cada passo depende do anterior por uma razão geométrica declarada.

```
(1) referência → medidas 2D normalizadas
        ↓
(2) escala da sala + câmera (altura, lente, alvo)
        ↓
(3) plano: grafo de cena, ordem, restrições
        ↓
(4) geometria: spec fechada ou código bpy
        ↓
(5) pré-checagem: projeção, AABB, suporte, contenção
        ↓
(6) render
        ↓
(7) comparação pós-render: SSIM/ΔE00/IoU
        ↓
(8) correção → volta para (3) ou (4)
```

### 3.1 Passo 1 — da imagem de referência aos parâmetros 2D

**O que é documentado.** A imagem entra como bloco de imagem; o modelo pode devolver coordenadas e caixas, com precisão limitada por resolução e formatação do pedido [4][5]. `[verificado]`

**O que não é documentado.** Nenhuma fonte Anthropic/OpenAI descreve o modelo extraindo distância focal, altura de câmera ou escala métrica de uma foto. `[inferido]` a partir da ausência e do escopo declarado em [4][5]. Afirmar que "o Claude mede a foto em metros" é `[folclore]`.

**O que resolve o problema de verdade.** Metrologia de vista única recupera medidas afins a partir de informação geométrica mínima (linha de fuga do plano de referência e ponto de fuga), não de "olhar" a foto.

> "3D affine measurements may be computed from a single perspective view of a scene given only minimal geometric information determined from the image" — [Criminisi, Reid & Zisserman, *Single View Metrology*][28] `[verificado]`

Para calibrar câmera (não metros), há modelos especializados que produzem campos de perspectiva por pixel:

> "per-pixel information about the camera view, parameterized as an up vector and a latitude value" — [Jin et al., *Perspective Fields for Single Image Camera Calibration*][26] `[verificado]`

Nada disso é o que um chat faz por padrão; são métodos que precisam ser executados por código. `[inferido]`

**A receita operacional (a que o pipeline usa).** Meça na imagem, em coordenadas normalizadas (0..1, origem no canto superior esquerdo):

| Parâmetro | Como obter | Unidade | Risco |
| --- | --- | --- | --- |
| `windowRect` | segmentação por brilho ou marcação manual | normalizado | 1–2 px deslocam a projeção |
| `horizonY` | linha do nível dos olhos / centro da janela | normalizado | horizonte obstruído |
| `cameraHeight` | altura do horizonte em relação ao piso | metros | depende de uma altura conhecida |
| `room.width/depth/height` | trena, planta ou laser | metros | erro de planta contamina tudo |
| `lens`/`sensorWidth` | EXIF da foto ou hipótese (24–35 mm) | mm | foto de celular sem EXIF |
| `sofaRect`/`tableRect` | marcação por cor/escuro | normalizado | oclusão e perspectiva |

No exemplo deste repositório, essas medidas estão declaradas no próprio JSON, com a nota de como foram obtidas: janela por segmentação de brilho, horizonte no centro da janela, altura de câmera igual ao centro da janela (1,15 m). [room-living.json][ex] `[verificado]` — o pipeline **não** lê a imagem; ele consome números já medidos. Essa é a lacuna central em relação ao que um modelo multimodal poderia propor.

### 3.2 Passo 2 — decidir escala e câmera ANTES dos móveis

**Por que antes.** A projeção de qualquer objeto depende de posição, alvo, lente e sensor. Mover a câmera depois de posicionar móveis invalida todo o enquadramento já conferido; portanto, a câmera é uma decisão de primeiro estágio. `[inferido]` — consequência direta do modelo pinhole descrito abaixo, não uma afirmação de uma fonte.

**A geometria, em uma linha.** Com `sensor_fit = HORIZONTAL`, a meia-largura normalizada é `sensor_width / (2·lens)` e a meia-altura é `sensor_height / (2·lens)`, com `sensor_height = sensor_width · H / W`. O Blender documenta o controle de FOV pela lente e o encaixe do sensor:

> "Longer focal lengths result in a smaller FOV (more zoom), while short focal lengths allow you to see more of the scene at once" — [Blender Manual, *Cameras*][30] `[verificado]`

> "Adjusts how the camera's sensor fits within the outputs dimension adjusting the angular field of view." — [Blender Manual, *Cameras*][30] `[verificado]`

O `Projector` do `validate.py` implementa exatamente essa conta (`tan_h = sensor_width / (2·lens)`, `tan_v = sensor_height / (2·lens)`), e o `build.py` fixa `sensor_fit = "HORIZONTAL"` na câmera. [validate.py][val] [build.py][bld] `[verificado]`

**O procedimento.**

1. Fixar as dimensões internas da sala em metros (o schema aceita 1,5–15 m de largura/profundidade e 2–6 m de altura). [room.js][rj] `[verificado]` O Blender chama essa convenção de sistema métrico:

> "Use the metric unit system in this scene." — [Blender Manual, *Scene Properties*][35] `[verificado]`
2. Fixar a altura da câmera igual à altura do horizonte medido — é o único vínculo métrico simples entre foto e cena. [28] `[verificado]` para a teoria; `[inferido]` para o atalho "horizonte = altura".
3. Escolher lente e sensor; com foto sem EXIF, tratar como hipótese e conferir pela projeção da janela.
4. Projetar a janela e comparar com `windowRect` medido: IoU ≥ 0,70 e erro de centro ≤ 0,05. [validate.py][val] `[verificado]`
5. Só então posicionar móveis e conferir `fullyVisible`.

No estado lido em 2026-11-04, o gate aprova o exemplo com IoU de janela 0,894 e erro de centro 0,009 (e emite um *warning* de layout, não erro). [validate.py][val] `[verificado]` — é uma execução local, não uma promessa de que o exemplo seja fotorrealista.

**Onde entra o "≥ 1 m".** O `validate.py` exige distância mínima de 1,0 m entre a câmera e qualquer sólido móvel (`CAMERA_MIN_DISTANCE = 1.0`, distância ponto–AABB). [validate.py][val] `[verificado]` O valor é uma regra de projeto deste pipeline, não um número publicado pela Anthropic/OpenAI ou pelo Blender: `[inferido]`. O Blender só documenta o near clip padrão de 0,1 m:

> "Camera near clipping distance (in [1e-06, inf], default 0.1)" — [Blender API, *bpy.types.Camera*][31] `[verificado]`

### 3.3 Passo 3 — planejar antes de executar

**Planejamento é uma coisa; garantia é outra.** Os sistemas de pesquisa que melhor documentam o processo quebram a tarefa em um grafo/plano antes de emitir geometria.

> "SceneCraft first models a scene graph as a blueprint, detailing the spatial relationships among assets in the scene." — [Hu et al., *SceneCraft*][17] `[verificado]`

> "translating relationships into numerical constraints for asset layout" — [Hu et al., *SceneCraft*][17] `[verificado]`

O 3D-GPT decompõe a tarefa e delega a agentes especializados:

> "dissecting the procedural 3D modeling tasks into accessible segments and appointing the apt agent for each task" — [Sun et al., *3D-GPT*][20] `[verificado]`

O Holodeck usa o LLM para gerar ambientes inteiros a partir de um prompt:

> "we present Holodeck, a system that generates 3D environments to match a user-supplied prompt fully automatedly" — [Yang et al., *Holodeck*][24] `[verificado]`

O LayoutGPT trata o LLM como planejador visual de layouts:

> "we study how Large Language Models (LLMs) can serve as visual planners by generating layouts from text conditions" — [Feng et al., *LayoutGPT*][25] `[verificado]`

E o LL3M nomeia o pipeline de agentes:

> "coordinates a team of specialized LLM agents to plan, retrieve, write, debug, and refine Blender scripts" — [Lu et al., *LL3M*][18] `[verificado]`

**Do lado dos produtos.** A Anthropic recomenda transparência do plano e "ground truth" a cada passo:

> "Prioritize transparency by explicitly showing the agent's planning steps." — [Anthropic, *Building effective AI agents*][7] `[verificado]`

> "During execution, it's crucial for the agents to gain "ground truth" from the environment at each step" — [Anthropic, *Building effective AI agents*][7] `[verificado]`

A OpenAI descreve modelos de raciocínio como planejadores:

> "We trained our o-series models ("the planners") to think longer and harder about complex tasks" — [OpenAI, *Reasoning best practices*][15] `[verificado]`

**Cuidado com o inverso.** A própria Anthropic observa que um plano rígido escrito à mão pode ser pior que instruir o modelo a pensar:

> "A prompt such as "think thoroughly" often produces better reasoning than a hand-written step-by-step plan." — [Anthropic, *Prompting best practices*][6] `[verificado]`

Portanto, o plano que o modelo segue **não é auditável** só porque aparece na conversa; o que é auditável é o artefato emitido (spec/código) e o resultado das ferramentas. `[inferido]` a partir de [6][7].

**A ordem que o pipeline adota** (contrato → medidas → câmera → casca → móveis grandes → props → assets → luz → render) é uma inferência de dependência geométrica, não uma receita publicada: `[inferido]`.

### 3.4 Passo 4 — emitir geometria: código ou spec fechada

Há dois modos reais, e eles têm trade-offs opostos.

| Modo | Como o modelo emite | Vantagem | Custo |
| --- | --- | --- | --- |
| Código `bpy` | Python executado por um addon/socket [37][38] | expressividade total | validação difícil; estado arbitrário |
| Spec JSON | documento fechado, validado por schema [12] | verificável, reproduzível | limitado ao que o schema prevê |

O BlenderGPT é o exemplo mais citado do primeiro modo:

> "Recent Large Language Models like OpenAI's GPT-4 can generate these Python scripts from simple English and execute them." — [gd3kr, *BlenderGPT*][38] `[verificado]`

No mundo CAD, a variante "paramétrica" troca código por uma sequência de parâmetros e mede precisão explicitamente:

> "the first AI framework for generating text-to-parametric CAD models using designer-friendly instructions for all skill levels" — [Khan et al., *Text2CAD*][22] `[verificado]`

O `room plan` deste repositório é o segundo modo: um schema v1 com chaves fechadas, materiais, paredes, móveis, assets, luz, câmera, render, avaliação e referência. `validate_plan` rejeita chave desconhecida e fora de faixa; `normalize_*` aplica limites (por exemplo, lente 8–300 mm, sensor 1–100 mm, `fstop` 0,7–64). [build_room.py][br] [spec.js][sp] `[verificado]`

A vantagem prática da spec é que o portão consegue raciocinar sobre ela sem executar código. `[inferido]`

### 3.5 Passo 5 — a auto-checagem antes de mostrar o trabalho

Há **duas** auto-checagens diferentes, frequentemente confundidas:

**(a) Checagem visual:** renderiza/screenshot e olha. É o que o servidor MCP chama de `look` e o que o SceneCraft faz com um VLM crítico.

> "leverages the perceptual strengths of vision-language foundation models like GPT-V to analyze rendered images and iteratively refine the scene" — [Hu et al., *SceneCraft*][17] `[verificado]`

> "agents can automatically self-critique using code and visuals" — [Lu et al., *LL3M*][18] `[verificado]`

**(b) Checagem determinística:** roda algo que devolve *pass/fail*. A Anthropic descreve exatamente por que isso muda o comportamento:

> "Claude stops when the work looks done. If it has nothing to run that tells it whether the work actually is done, "looks done" is all it has to go on." — [Anthropic, *Best practices for Claude Code*][9] `[verificado]`

> "If you give it something that comes back pass or fail, Claude can close that loop itself." — [Anthropic, *Best practices for Claude Code*][9] `[verificado]`

A Anthropic aplica o mesmo princípio à avaliação de ferramentas: o resultado precisa ser verificável, não "parecer certo".

> "Each evaluation prompt should be paired with a verifiable response or outcome." — [Anthropic, *Writing effective tools for AI agents*][8] `[verificado]`

A diferença não é sutil: (a) produz uma opinião sobre pixels; (b) produz um veredito reproduzível sobre invariantes. O pipeline deste repositório faz (b) **antes** do render e uma comparação **numérica** depois; não faz (a). `[verificado]` no código; a recomendação de separar as duas é `[inferido]`.

### 3.6 Passo 6 — o que é validação real

Definição operacional usada aqui: **validação é uma medida que pode falhar de forma reproduzível**. Ela tem três camadas, e nenhuma delas sozinha prova fotorrealismo.

| Camada | O que mede | O que prova | O que **não** prova |
| --- | --- | --- | --- |
| Contrato/schema | tipos, faixas, chaves, material existente | que o plano é bem formado | que a cena é possível |
| Geometria determinística | AABB, suporte, contenção, distância, projeção | que invariantes espaciais valem | que a imagem se parece com a foto |
| Comparação de imagem | SSIM, ΔE00, histograma, IoU | aderência mensurável sob o mesmo enquadramento | realismo absoluto ou intenção |

A própria documentação do `evaluate.py` declara o limite:

> "Nenhuma métrica prova fotorrealismo absoluto: elas medem aderência mensurável a uma referência específica." — [evaluate.py][ev] `[verificado]`

E o SSIM, usado como similaridade, é definido assim:

> "The Structural SIMilarity (SSIM) index is a method for measuring the similarity between two images." — [Wang et al., *SSIM*][29] `[verificado]`

**Pré-render vs. pós-render.** O portão determinístico roda **antes** do render porque ele não olha a imagem: ele verifica o plano resolvido. Métricas de imagem rodam **depois**, porque dependem do PNG. Trocar um pelo outro é o erro mais comum: um SSIM alto pode esconder um objeto flutuando fora do quadro; uma cena geometricamente válida pode ter cor errada. `[inferido]`

### 3.7 Passo 7 — corrigir e repetir

Os sistemas que documentam o loop mostram correção baseada no estado que a ferramenta devolve, não em "tentar de novo".

> "assess the impact of generated CAD commands on geometry and adapts subsequent actions based on the evolving state of the CAD design" — [Mallis et al., *CAD-Assistant*][23] `[verificado]`

> "iterative prompting mechanism that incorporates environment feedback, execution errors, and self-verification for program improvement" — [Wang et al., *Voyager*][27] `[verificado]`

Não há, nas fontes consultadas, garantia de convergência nem número oficial de iterações "típicas". `[verificado]` para a ausência; `[inferido]` para a necessidade de orçamento explícito.

---

## 4. Onde o método falha

| Falha | Evidência | Consequência prática | Rótulo |
| --- | --- | --- | --- |
| Coordenadas de imagem imprecisas | [4][5] | medida de janela/móvel desloca a projeção | `[verificado]` |
| Sem EXIF, lente é hipótese | [30] + exemplo sem EXIF | FOV errado compensado por posição errada | `[inferido]` |
| Oclusão: só se mede o visível | [28] | geometria escondida pode interpenetrar | `[inferido]` |
| VLM crítico erra | [21] | "parece bom" não é veredito | `[verificado]` |
| Geração de script erra | [19] | código executa, mas CAD/geometria fica errada | `[verificado]` |
| AABB ignora rotação do móvel | `resolve_plan` usa centro e tamanho sem rotação [br] | interseção pode passar ou falhar indevidamente | `[verificado]` |
| Bbox de asset só gira em Z | `asset_world_bbox` [br] | asset inclinado em X/Y tem caixa errada | `[verificado]` |
| Mesmo grupo é isento | `check_intersections` [val] | duas cópias do mesmo asset podem se sobrepor | `[verificado]` |
| Aberturas não entram na contenção | `collect_objects` só inclui móveis/assets [val] | móvel pode tapar janela sem erro | `[verificado]` |
| Distância ≠ linha de visão | `point_bbox_distance` [val] | parede entre câmera e cena não é detectada | `[verificado]` |
| Métricas dependem de exposição/tonemapping | `LIMITATIONS` [ev] | ΔE00 alto pode ser luz, não material | `[verificado]` |
| `--resize fit` mascara enquadramento | `evaluate.py` [ev] | referência redimensionada esconde erro de composição | `[inferido]` |

**Comentário por linha.** As duas primeiras falhas são de **medição**: sem intrinsics confiáveis, a câmera é ajustada para fazer a janela bater, o que pode produzir uma câmera fisicamente implausível. As falhas de AABB são de **modelo**: a caixa alinhada aos eixos é uma aproximação; para móveis rotacionados, ela não é o volume real. As falhas de cobertura são de **escopo**: o gate não vê paredes, aberturas, oclusão nem linhas de visão. Nenhuma delas é detectável por SSIM. `[inferido]`

Dois detalhes técnicos importam para quem for corrigir isso. Primeiro, a API do Blender define a caixa em espaço de objeto, não de mundo:

> "Object's bounding box in object-space coordinates" — [Blender API, *bpy.types.Object*][32] `[verificado]`

Segundo, o ΔE00 não é independente de tone mapping; o Blender 4.3 descreve o AgX como o transform que altera a resposta de cor:

> "A tone mapping transform that improves on Filmic" — [Blender 4.3 Manual, *Color Management*][34] `[verificado]`

Logo, comparar ΔE00 entre render e foto sem fixar view transform e exposição mede, em parte, a escolha de color management — não o material. `[inferido]`

---

## 5. O que é folclore

| Afirmação popular | Rótulo | Por que não se sustenta |
| --- | --- | --- |
| "Claude tem um modo 3D / abre o Blender sozinho" | `[folclore]` | O caminho documentado é tool use/MCP; o código roda na aplicação [1][11][37]. |
| "MCP dá ao modelo compreensão espacial da cena" | `[folclore]` | MCP transporta chamadas; a geometria fica no addon [3][37]. |
| "O modelo mede a foto em metros" | `[folclore]` | Visão devolve coordenadas aproximadas; metrologia exige calibração [4][5][28]. |
| "Code Interpreter roda o Blender da minha máquina" | `[folclore]` | É sandbox da OpenAI, não o Blender local [13]. |
| "Canvas modela 3D" | `[folclore]` | Canvas é superfície de escrita/código [16]. |
| "SSIM/ΔE00 altos provam fotorrealismo" | `[folclore]` | Medem similaridade/aderência sob condições específicas [29][ev]. |
| "Se o render parece bom, está validado" | `[folclore]` | "Looks done" não é check; o próprio Claude Code distingue [9]. |
| "A auto-crítica converge sempre" | `[folclore]` | Há loops, mas BlenderGym/BlenderLLM mostram falhas persistentes [19][21]. |
| "Um plano passo a passo garante o resultado" | `[folclore]` | O plano é texto; a Anthropic diz que pensar pode superar plano rígido [6][7]. |
| "Computer use opera o Blender do usuário por padrão" | `[inferido]` | Clicar na UI é possível em ambiente controlado [10], mas não há integração documentada com o Blender local. |
| "O modelo vê a cena 3D" | `[folclore]` | Ele vê texto/JSON/PNG; não recebe malha nem grafo de cena [37]. |

---

## 6. Tradução para o pipeline deste repositório

Os nomes abaixo foram lidos no código em 2026-11-04. Onde a função não existe, está escrito **não implementado**. O gate `validate.py` existe e é chamado pelo `build_room.py` **antes** do render (`run_gate`, salvo `--skip-validation`). [br] `[verificado]`

### 6.1 Método → arquivo/função

| Passo do método | Onde está no repositório | Status |
| --- | --- | --- |
| Contrato de cena e escala | `lib/room.js`: `validateRoomPlan`, `normalizeRoom`, `LIMITS` (1,5–15 m, 2–6 m); `build_room.py`: `validate_plan`, `normalize_room` | Implementado |
| Unidade métrica | Convenção do schema (metros); não há campo de unidade; Blender usa `Metric` [35] | Implementado por convenção; `[inferido]` que 1 unidade = 1 m |
| Ler referência e medir 2D | `build_room.py`: `normalize_reference` (`windowRect`, `horizonY`, `cameraHeight`, `sofaRect`, `tableRect`); valores em `examples/room-living.json` | Implementado como **entrada manual**; não há leitura automática de imagem |
| Câmera antes dos móveis | `build_room.py`: `normalize_camera`; `lib/spec.js`: `normalizeCamera`; `build.py`: `build_camera` | Implementado; a câmera é **dada**, não resolvida |
| Checar câmera contra a referência | `validate.py`: `check_layout` (`CAMERA_HEIGHT_TOLERANCE=0.05`, `WINDOW_IOU_MIN=0.70`, `WINDOW_CENTER_TOLERANCE=0.05`) | Implementado |
| Enquadramento | `validate.py`: `check_framing`, `Projector.project_bbox`, `FRAMING_TOLERANCE=0.002`; lista `reference.fullyVisible` | Implementado (pulado se a lista estiver vazia) |
| Distância mínima da câmera | `validate.py`: `check_camera_distance`, `CAMERA_MIN_DISTANCE=1.0`, `point_bbox_distance` | Implementado (regra de projeto, não norma) |
| Interseção AABB entre grupos | `validate.py`: `check_intersections`, `overlap`, `INTERSECTION_TOLERANCE=0.02`; grupo = `collisionGroup` ou prefixo do id; `detail: true` isento | Implementado |
| Suporte | `validate.py`: `check_support`, `SUPPORT_GAP=0.02`, `FLOOR_TOLERANCE=0.02`; `support` ∈ `floor/furniture/wall/ceiling` | Implementado |
| Contenção | `validate.py`: `check_containment`, `CONTAINMENT_TOLERANCE=0.01` | Implementado (só móveis/assets) |
| Inventário acima de 2,6 m | `validate.py`: `check_inventory`, `INVENTORY_HEIGHT=2.6`, `reference.inventory` | Implementado |
| Asset dentro de móvel | `validate.py`: `check_assets`, `point_inside_volume` (eixo) + interseção de volume entre `asset:{assetId}` e móveis | Implementado |
| Bbox de asset | `build_room.py`: `asset_world_bbox` (`fitHeight`, `anchor`, rotação Z); `assets-library.json.bbox` | Implementado com limitação (só Z) |
| Importação de assets | `build_room.py`: `import_assets`, `import_asset_gltf`, `import_asset_blend`; glTF suporta meshes/materiais [36] | Implementado |
| Portão pré-render | `build_room.py`: `run_gate`, `--validate`, `--skip-validation`; `validate.py --resolved`; grava `validation.json` | Implementado |
| Render | `build_room.py`: `clear_scene` (`bpy.ops.wm.read_factory_settings(use_empty=True)` [33]), `render_stage_spec`; `build.py`: `configure_render`, `render_image` | Implementado |
| Comparação pós-render | `evaluate.py`: `evaluate`, `check_thresholds`, `ssim_gray`, `delta_e_2000`, `histogram_distance`, `iou`; grava `report.json` e `comparison.png` | Implementado |
| Loop de correção automática | — | **Não implementado** (render único; correção é humana) |
| Planejamento/decomposição | `planner.js` (v2) gera spec de intenção; não alimenta o `room plan` v3 | **Não implementado no v3** |
| Crítico visual | `critic.js` converte métricas em correções priorizadas; não analisa imagem nem chama modelo | Parcial (esqueleto) |
| Schema documentado | `schema-room.md` documenta `reference`, o resolved, o portão e a avaliação | Implementado |

### 6.2 As regras do gate, com os números do código

| Regra | Função | Constante | O que reprova |
| --- | --- | --- | --- |
| `intersection` | `check_intersections` | 0,02 m nos 3 eixos | penetração entre grupos diferentes |
| `support` | `check_support` | folga 0,02 m; piso 0,02 m | peça flutuando ou enterrada |
| `containment` | `check_containment` | 0,01 m | peça fora do volume interno |
| `camera-distance` | `check_camera_distance` | 1,0 m | câmera perto demais de sólido |
| `framing` | `check_framing` | 0,002 (NDC) | canto do AABB fora do frustum |
| `inventory` | `check_inventory` | 2,6 m | peça alta fora do inventário |
| `layout` | `check_layout` | IoU 0,70; centro 0,05; altura 0,05 m | janela projetada difere da foto |
| `assets` | `check_assets` | — | asset ausente ou sem bbox |

Todas as oito são determinísticas e rodam sem imagem. [val] `[verificado]`

### 6.3 O que o pós-render mede

| Métrica | Função | Limiar do exemplo | Limite declarado |
| --- | --- | --- | --- |
| SSIM | `ssim_gray` | ≥ 0,50 | similaridade estrutural, não realismo |
| ΔE00 médio | `delta_e_2000` | ≤ 20 | depende de luz/tonemapping |
| ΔE00 por região | `region_metrics` | ≤ 30 | idem |
| Histograma | `histogram_distance` | ≤ 0,30 | distribuições parecidas ≠ cenas iguais |
| IoU de silhueta | `iou` | ≥ 0,60 | só com máscaras; ignora detalhe interno |

Os limiares vêm de `evaluation.thresholds` no `room plan` e são, nas palavras do próprio exemplo, "piso de regressão, não prova de fotorrealismo". [ex] [ev] `[verificado]`

### 6.4 Comandos reproduzíveis

```bash
# 1. validar e resolver o plano sem Blender, rodando o gate
python3 tools/blender-director/build_room.py \
  --room tools/blender-director/examples/room-living.json \
  --dry-run --validate --resolved /tmp/resolved.json

# 2. rodar o gate isoladamente (exit 0 = válido, 2 = reprovado)
python3 tools/blender-director/validate.py \
  --resolved /tmp/resolved.json --out /tmp/validation.json

# 3. render (o gate roda de novo antes; --skip-validation desliga)
blender -b --python-exit-code 1 -P tools/blender-director/build_room.py -- \
  --room tools/blender-director/examples/room-living.json \
  --out runs/sala --stage preview --preview-index 1 --progress-json

# 4. comparar o render com a referência
python3 tools/blender-director/evaluate.py \
  --render runs/sala/preview-001.png \
  --room tools/blender-director/examples/room-living.json --json

# 5. conferir assets e licenças
node tools/blender-director/assets.js validate \
  --room tools/blender-director/examples/room-living.json --require-files
```

Os flags acima existem nos parsers: `build_room.py --room --out --dry-run --validate --resolved --stage --preview-index --progress-json --skip-validation`; `validate.py --resolved --out --json --allow-missing-assets --quiet`; `evaluate.py --render --room --reference --config --out --resize --json`; `assets.js list|validate|plan|fetch --room --library --require-files`. [br] [val] [ev] [as] `[verificado]`

### 6.5 Lacunas explícitas

- **Não há visão no loop:** `reference.measurements` é preenchido à mão; o pipeline não propõe `windowRect` a partir da imagem. [br] `[verificado]`
- **Não há planejador v3:** o `planner.js` é da v2 e produz outro contrato; o `room plan` v3 é autoral. `[verificado]`
- **Não há crítico de imagem:** `critic.js` prioriza correções a partir de métricas; não gera crítica visual. `[verificado]`
- **Não há loop:** um render por execução; não há orçamento de iterações nem parada por convergência. `[verificado]`
- **AABB de móvel ignora rotação** e **bbox de asset ignora X/Y**: o gate pode aprovar uma penetração real. [br] `[verificado]`
- **Aberturas não são checadas contra móveis**: um sofá pode tapar a janela sem erro. [val] `[verificado]`
- **Sem oclusão**: a distância da câmera é ponto–AABB, não linha de visão. [val] `[verificado]`
- **Documentação dividida:** o room plan v3 está em [`schema-room.md`][sr], e o README já descreve o gate; o `schema.md` antigo continua sendo o contrato v1 e não cobre `reference`/portão. `[verificado]`

---

## 7. As três perguntas

### 7.1 Como decidir câmera e escala ANTES de posicionar móveis?

Meça na foto a janela (retângulo normalizado), o horizonte e uma altura conhecida; adote a altura do horizonte como altura da câmera e converta a largura da sala para metros com uma medida física (trena/planta). Escolha lente e sensor, projete a janela e compare com o retângulo medido (IoU ≥ 0,70, centro ≤ 0,05) antes de criar qualquer móvel. Se a projeção não bater, ajuste câmera/lente — não mova os móveis para compensar. No pipeline: `reference.measurements`, `normalize_camera` e `check_layout`. `[inferido]` como ordem de engenharia; as regras e tolerâncias são `[verificado]` no código.

### 7.2 O que exatamente validar antes de renderizar (não depois)?

Antes do render, valide o que não depende de pixels: schema e faixas; unidade/escala; câmera a ≥ 1 m de sólidos; contenção no volume interno; suporte (nada flutuando/enterrado); interseção AABB entre grupos; inventário acima de 2,6 m; projeção da janela e dos objetos `fullyVisible`; existência e bbox dos assets. Isso é o que o `validate.py` faz, com exit 2 em reprovação. `[verificado]` Deixe para depois apenas o que exige imagem: SSIM, ΔE00, histograma e IoU de silhueta — e trate-os como aderência, não como prova. `[inferido]`

### 7.3 O que o Claude faz nesse ponto que o pipeline ainda não faz?

O Claude (via tool use/MCP) pode **ler a imagem**, propor medidas e regiões, escrever o plano/código, executar ferramentas, olhar o render e iterar com base no erro. [1][4][37] O pipeline v3 não tem visão, planejador integrado, crítico de imagem nem loop; ele tem um contrato fechado e um gate determinístico que o modelo não tem. `[verificado]` A combinação defensável é usar o modelo para **propor** e o gate para **decidir** — nunca o contrário. `[inferido]` E lembre: a proposta visual do modelo é aproximada e falha em imagens pequenas/rotacionadas [4], e o crítico VLM ainda erra tarefas simples de Blender [21]. `[verificado]`

---

## 8. Fontes

Todas as URLs foram verificadas por HTTP em 2026-11-04. O trecho citado no corpo é curto e atribuído; a fonte abaixo é a referência completa.

### Anthropic

1. **Anthropic.** *Tool use with Claude* — Claude Platform Docs. s.d. (acesso 2026-11-04). https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview
2. **Anthropic.** *MCP connector* — Claude Platform Docs. s.d. https://platform.claude.com/docs/en/agents-and-tools/mcp-connector
3. **Anthropic.** *Introducing the Model Context Protocol*. 2024. https://www.anthropic.com/news/model-context-protocol
4. **Anthropic.** *Vision* — Claude Platform Docs. s.d. https://platform.claude.com/docs/en/build-with-claude/vision
5. **Anthropic.** *Coordinates and bounding boxes* — Claude Platform Docs. s.d. https://platform.claude.com/docs/en/build-with-claude/vision-coordinates
6. **Anthropic.** *Prompting best practices* — Claude Platform Docs. s.d. https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices
7. **Anthropic.** *Building effective AI agents*. 2024. https://www.anthropic.com/research/building-effective-agents
8. **Anthropic.** *Writing effective tools for AI agents*. 2025. https://www.anthropic.com/research/writing-tools-for-agents
9. **Anthropic.** *Best practices for Claude Code* — Claude Code Docs. s.d. https://code.claude.com/docs/en/best-practices
10. **Anthropic.** *Computer use tool* — Claude Platform Docs. s.d. https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool

### OpenAI

11. **OpenAI.** *Function calling* — API Docs. s.d. https://developers.openai.com/api/docs/guides/function-calling
12. **OpenAI.** *Structured model outputs* — API Docs. s.d. https://developers.openai.com/api/docs/guides/structured-outputs
13. **OpenAI.** *Code Interpreter* — API Docs. s.d. https://developers.openai.com/api/docs/guides/tools-code-interpreter
14. **OpenAI.** *Images and vision* — API Docs. s.d. https://developers.openai.com/api/docs/guides/images-vision
15. **OpenAI.** *Reasoning best practices* — API Docs. s.d. https://developers.openai.com/api/docs/guides/reasoning-best-practices
16. **OpenAI.** *Introducing Canvas*. 2024. Cópia arquivada: https://web.archive.org/web/20241231233136/https://openai.com/index/introducing-canvas/ — original (403 para clientes automatizados): https://openai.com/index/introducing-canvas/

### Papers (arXiv, IJCV, IEEE)

17. **Ziniu Hu et al.** *SceneCraft: An LLM Agent for Synthesizing 3D Scene as Blender Code*. 2024. https://arxiv.org/abs/2403.01248
18. **Sining Lu et al.** *LL3M: Large Language 3D Modelers*. 2025. https://arxiv.org/abs/2508.08228
19. **Yuhao Du et al.** *BlenderLLM: Training Large Language Models for Computer-Aided Design with Self-improvement*. 2024. https://arxiv.org/abs/2412.14203
20. **Chunyi Sun et al.** *3D-GPT: Procedural 3D Modeling with Large Language Models*. 2023. https://arxiv.org/abs/2310.12945
21. **Yunqi Gu et al.** *BlenderGym: Benchmarking Foundational Model Systems for Graphics Editing*. 2025. https://arxiv.org/abs/2504.01786
22. **Mohammad Sadil Khan et al.** *Text2CAD: Generating Sequential CAD Models from Beginner-to-Expert Level Text Prompts*. 2024. https://arxiv.org/abs/2409.17106
23. **Dimitrios Mallis et al.** *CAD-Assistant: Tool-Augmented VLLMs as Generic CAD Task Solvers*. 2024. https://arxiv.org/abs/2412.13810
24. **Yue Yang et al.** *Holodeck: Language Guided Generation of 3D Embodied AI Environments*. 2023. https://arxiv.org/abs/2312.09067
25. **Weixi Feng et al.** *LayoutGPT: Compositional Visual Planning and Generation with Large Language Models*. 2023. https://arxiv.org/abs/2305.15393
26. **Linyi Jin et al.** *Perspective Fields for Single Image Camera Calibration*. 2022. https://arxiv.org/abs/2212.03239
27. **Guanzhi Wang et al.** *Voyager: An Open-Ended Embodied Agent with Large Language Models*. 2023. https://arxiv.org/abs/2305.16291
28. **Antonio Criminisi, Ian Reid & Andrew Zisserman.** *Single View Metrology*. IJCV, 2000. https://www.microsoft.com/en-us/research/publication/single-view-metrology/
29. **Zhou Wang, Alan C. Bovik, Hamid R. Sheikh & Eero P. Simoncelli.** *Image quality assessment: from error visibility to structural similarity*. IEEE TIP, 2004. https://doi.org/10.1109/TIP.2003.819861 — página do autor: https://www.ece.uwaterloo.ca/~z70wang/research/ssim/

### Blender Foundation

30. **Blender Foundation.** *Cameras* — Blender 5.2 LTS Manual. 2026. https://docs.blender.org/manual/en/latest/render/cameras.html
31. **Blender Foundation.** *bpy.types.Camera* — Blender Python API. 2026. https://docs.blender.org/api/current/bpy.types.Camera.html
32. **Blender Foundation.** *bpy.types.Object* — Blender Python API. 2026. https://docs.blender.org/api/current/bpy.types.Object.html
33. **Blender Foundation.** *bpy.ops.wm* — Blender Python API. 2026. https://docs.blender.org/api/current/bpy.ops.wm.html
34. **Blender Foundation.** *Color Management* — Blender 4.3 Manual. 2024. https://docs.blender.org/manual/en/4.3/render/color_management.html
35. **Blender Foundation.** *Scene Properties* — Blender 5.2 LTS Manual. 2026. https://docs.blender.org/manual/en/latest/scene_layout/scene/properties.html
36. **Blender Foundation.** *glTF 2.0* — Blender 4.3 Manual. 2024. https://docs.blender.org/manual/en/4.3/addons/import_export/scene_gltf2.html

### Repositórios oficiais de sistemas

37. **ahujasid.** *mcp-for-blender* (ex-`blender-mcp`) — GitHub. s.d. https://github.com/ahujasid/blender-mcp
38. **gd3kr.** *BlenderGPT* — GitHub. s.d. https://github.com/gd3kr/BlenderGPT

### Fontes do próprio repositório

[br]: ../tools/blender-director/build_room.py
[val]: ../tools/blender-director/validate.py
[ev]: ../tools/blender-director/evaluate.py
[as]: ../tools/blender-director/assets.js
[rj]: ../tools/blender-director/lib/room.js
[sp]: ../tools/blender-director/lib/spec.js
[bld]: ../tools/blender-director/build.py
[ex]: ../tools/blender-director/examples/room-living.json

> **Nota sobre links internos:** os ponteiros `[br]`, `[val]`, `[ev]`, `[as]`, `[rj]`, `[sp]`, `[bld]` e `[ex]` referenciam arquivos deste repositório por caminho relativo a partir de `docs/`. As citações de código foram lidas diretamente dos arquivos e, quando possível, executadas localmente.

---

## 9. Apêndice — checklist operacional

### Antes do render (determinístico, sem imagem)

- [ ] `room plan` valida contra o schema; nenhuma chave desconhecida.
- [ ] Dimensões internas em metros, dentro de 1,5–15 m e 2–6 m.
- [ ] Câmera: `location`, `target` **ou** `rotation` (nunca os dois), lente 8–300 mm.
- [ ] `reference.measurements.windowRect` e `cameraHeight` preenchidos.
- [ ] `validate.py`: `layout` e `framing` passam; `inventory` cobre tudo acima de 2,6 m.
- [ ] `intersection`, `support`, `containment` e `camera-distance` sem erros.
- [ ] Assets baixados (`--require-files`) e com `bbox` declarada.
- [ ] `validation.json` gravado em `out_dir`; exit 0.

### Depois do render (comparação)

- [ ] Mesmo enquadramento/resolução; `--resize error` quando quiser detectar diferença.
- [ ] SSIM, ΔE00, histograma e IoU registrados em `report.json`.
- [ ] Regiões de referência (janela, sofá, mídia, piso, teto) com ΔE00 dentro do limiar.
- [ ] `comparison.png` inspecionado por humano — mas **não** como veredito.
- [ ] Se falhar: corrigir câmera/geometria primeiro; cor/luz depois; nunca "ajustar until SSIM subir".

### O que nunca fazer

- Não tratar `look`/screenshot como validação.
- Não usar SSIM alto como prova de fotorrealismo.
- Não mover a câmera depois de validar o enquadramento sem revalidar tudo.
- Não executar `bpy` arbitrário de um modelo sem sandbox/limites.
- Não citar "Claude para Blender" como produto oficial: não há, nas fontes consultadas.

---

*Documento produzido para o Blender Director v3. Todas as citações têm menos de 40 palavras; nenhuma imagem; nenhum conteúdo privado ou credencial.*
