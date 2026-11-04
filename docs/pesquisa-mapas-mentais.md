# Pesquisa: editores de mapas mentais e arquitetura de um protótipo web

> Levantamento de apoio ao protótipo v1 em `index.html`. O foco é responder a três perguntas: (1) o que as ferramentas atuais oferecem, (2) o que realmente as diferencia e (3) como construir algo útil em um único arquivo HTML, sem build step e sem dependências.
>
> Levantamento realizado em novembro de 2026. A seção [O que foi verificado](#o-que-foi-verificado-e-o-que-ficou-por-verificar) separa o que foi conferido em fonte primária do que ficou fora de alcance.

## 1. Panorama

O mercado se divide em quatro famílias:

1. **Ferramentas dedicadas a mapas mentais** — Xmind, MindMeister, Coggle, Freeplane. Otimizadas para hierarquia, brainstorming e apresentação do mapa.
2. **Quadros infinitos e suítes visuais** — Miro e Whimsical. O mapa mental é um entre vários formatos (fluxograma, wireframe, quadro branco).
3. **Diagramação geral** — draw.io/diagrams.net. Cobre mapas mentais por meio de formas e conectores, sem ser especializado nisso.
4. **Texto → mapa** — markmap. O conteúdo nasce em Markdown e o mapa é uma visualização dele.

Essa divisão importa para o protótipo: um editor de arquivo único consegue entregar bem o núcleo da família 1 (criar, organizar e conectar ideias), mas não compete com a colaboração e a IA das suítes da família 2.

## 2. Tabela comparativa

| Ferramenta | Licença / modelo | Stack | Recursos principais | Pontos fortes | Pontos fracos |
| --- | --- | --- | --- | --- | --- |
| **Xmind** | Proprietária; freemium com assinatura (SaaS/desktop) | App desktop (Electron), web e apps iOS/Android | Mapas com estruturas e layouts variados, temas, IA para gerar/expandir, modo apresentação, outliner, notas/anexos, colaboração em tempo real, integrações | Acabamento visual e variedade de layouts; forte no desktop; ecossistema maduro | Fechada e por assinatura; formato `.xmind` proprietário; colaboração chegou depois de concorrentes |
| **MindMeister** | Proprietária; freemium com planos por usuário | Web (SaaS) + apps iOS/Android | Mapas colaborativos em tempo real, IA, templates, modo apresentação, comentários e histórico, integrações (ex.: MeisterTask) | Colaboração simples e madura; onboarding fácil; bom para equipes | Plano gratuito limitado a 3 mapas; menos flexível fora do formato de mapa; dependente da nuvem |
| **Miro** | Proprietária; freemium com planos por time | Web (SaaS) com canvas acelerado por WebGL + apps desktop/mobile | Quadro infinito, ferramenta de mapa mental, templates, workshops, comentários, IA, integrações e embeds | Canvas mais poderoso da lista; excelente para trabalho visual em equipe; ecossistema enorme | Pesado e amplo demais para quem só quer um mapa; custo por assento; exige internet |
| **Whimsical** | Proprietária; freemium com planos por usuário | Web (SaaS) + apps desktop/mobile | Mapas mentais, fluxogramas, wireframes e docs no mesmo espaço; IA para gerar/expandir; tempo real; apresentação; comentários | Interface limpa e rápida; combina mapa, fluxo e documento; IA útil no dia a dia | Fechada e por assinatura; menos recursos avançados de mapa (fórmulas, filtros, automação); limites no plano gratuito |
| **Coggle** | Proprietária; freemium com planos | Web (SaaS), JavaScript | Mapas colaborativos, ramificações, fluxogramas, imagens/ícones, histórico, exportação PDF/PNG/.mm/.txt | Curva de aprendizado baixa; colaboração em tempo real; bom custo-benefício | Visual mais simples; plano gratuito restrito; pouca automação de layout |
| **Freeplane** | Open source, **GPL-2.0** | Java (Swing), desktop Windows/macOS/Linux | Mapas hierárquicos, fórmulas, scripts (Groovy), atributos e filtros, estilos/CSS, ícones, imagens, LaTeX, integração de IA/MCP recente, exportação HTML/PDF | Gratuito e offline; extremamente poderoso e extensível; comunidade ativa | Interface desktop datada; curva de aprendizado alta; sem colaboração em tempo real; só desktop |
| **draw.io / diagrams.net** | Open source, **Apache-2.0** | JavaScript client-side; web + app desktop (Electron) | Diagramas gerais (fluxogramas, UML, redes), templates de mapa mental, integrações (Drive, GitHub, GitLab, Atlassian), exportação variada, plugins | Grátis e aberto; privacidade (não guarda diagramas no servidor); funciona offline; integrações fortes | Não é focado em mapa mental (sem layout automático de árvore); UI densa; fluxo de ideação mais lento |
| **markmap** | Open source, **MIT** | TypeScript/JavaScript + D3 | Converte Markdown (títulos e listas) em mapa mental interativo; embedável; extensão de VS Code; exporta HTML/SVG/PNG | Leve; ótimo para documentação versionada; autolayout a partir do texto; fácil de embutir | É visualização, não edição direta; sem colaboração; pouca customização visual |

Leituras da tabela:

- **Licença não é o mesmo que abertura de formato.** draw.io é Apache-2.0, mas seus arquivos são XML proprietário (`.drawio`); markmap é MIT e usa Markdown puro. Para portabilidade, o formato importa tanto quanto a licença.
- **Colaboração em tempo real** deixou de ser diferencial exclusivo e virou item de base nas suítes comerciais; nas open source de desktop (Freeplane) ela segue ausente.
- **Freeplane é a exceção poderosa do mundo aberto**: fórmulas, scripts e filtros não aparecem em nenhuma ferramenta web simples — mas tudo isso vem com uma UI de outra década.

## 3. Os 5 recursos que mais diferenciam as ferramentas avançadas

### 3.1 IA como copiloto do mapa

Gerar um mapa a partir de um prompt ou documento, expandir um nó, resumir um ramo inteiro e sugerir conexões. Presente em Xmind, MindMeister, Miro, Whimsical e, mais recentemente, na integração de IA do Freeplane.

**Por que diferencia:** reduz o custo de começar e de reorganizar. É o recurso mais promovido comercialmente hoje.
**No protótipo:** fora de escopo (exigiria chave de API e chamadas de rede). A arquitetura deve permitir **importar uma estrutura gerada fora** — por isso o formato JSON aberto é importante.

### 3.2 Colaboração em tempo real

Presença de cursores, edição simultânea, comentários e histórico. Padrão em MindMeister, Coggle, Miro, Whimsical e Xmind.

**Por que diferencia:** transforma o mapa em artefato de equipe, não só de uso pessoal.
**No protótipo:** fora de escopo (exige backend, WebSocket/CRDT e autenticação). O protótipo é explicitamente local; a limitação deve estar documentada.

### 3.3 Canvas infinito com conteúdo heterogêneo

Nós, imagens, links, embeds, frames, desenho à mão e outros diagramas no mesmo espaço. Miro, Whimsical, draw.io e o formato JSON Canvas (Obsidian) exemplificam bem.

**Por que diferencia:** o mapa deixa de ser só texto e vira uma área de trabalho visual.
**No protótipo:** viável em parte — pan/zoom infinito com nós de texto é o núcleo; imagens e embeds ficam para depois.

### 3.4 Múltiplas visões sincronizadas e organização automática

Mapa ↔ outline ↔ apresentação, layouts automáticos, filtros/foco e reorganização por atalho. Xmind (estruturas e Pitch), MindMeister (outline e apresentação), markmap (autolayout a partir do Markdown) e Freeplane (filtros e estilos condicionais) cobrem pedaços diferentes disso.

**Por que diferencia:** a mesma informação serve para pensar, revisar e apresentar sem retrabalho.
**No protótipo:** o modelo de dados deve permitir derivar um outline depois; o v1 entrega apenas a visão de mapa.

### 3.5 Dados portáveis, integrações e embeddability

Exportar/importar JSON, Markdown, SVG, PDF; embutir o mapa em outro site; conectar com Drive/GitHub/Notion. markmap, draw.io e o formato aberto JSON Canvas são as referências mais claras de portabilidade.

**Por que diferencia:** evita aprisionamento e permite que o mapa circule entre ferramentas.
**No protótipo:** é o diferencial mais alcançável — JSON documentado, exportação/importação e um único arquivo que roda em qualquer lugar.

**Resumo:** as ferramentas avançadas competem por IA e colaboração; o espaço realista para um protótipo sem backend é **fluidez de edição + canvas infinito + dados portáveis**. Foi essa a aposta do v1.

## 4. Arquitetura recomendada para um protótipo web sem build step

### 4.1 Princípios

- **Um arquivo, zero dependências.** HTML + CSS + JavaScript no mesmo `index.html`, sem CDN, npm, bundler ou transpilação. Deve funcionar via `file://`.
- **JavaScript moderno que o navegador já entende.** `const`/`let`, arrow functions, template literals, `Map`, `Set`, `Pointer Events`. Sem TypeScript, sem JSX.
- **Renderização em SVG com um grupo transformado.** Um único `transform="translate(...) scale(...)"` no grupo `world` implementa pan e zoom; o resto do desenho fica em coordenadas de mundo.
- **Estado separado da renderização.** Os dados são objetos simples; funções de render desenham a partir deles. Isso torna desfazer/refazer, exportar e importar triviais.

### 4.2 Modelo de dados

```json
{
  "formatVersion": 1,
  "viewport": { "x": 720, "y": 450, "scale": 1 },
  "nodes": [
    { "id": "n-raiz", "text": "Mapa mental", "x": 0, "y": 0 },
    { "id": "n-ideias", "text": "Ideias", "x": 260, "y": -96 }
  ],
  "edges": [
    { "id": "e-1", "from": "n-raiz", "to": "n-ideias" }
  ]
}
```

Decisões e justificativas:

- **Coordenadas no centro do nó, em unidades de mundo** — mover, conectar e calcular interseções de borda ficam simples.
- **Arestas dirigidas (`from` → `to`)** — um mapa mental é uma hierarquia, mas o editor não impõe árvore: conexões livres são permitidas.
- **IDs string** — sobrevivem a importação, não dependem da posição no array e podem vir de ferramentas externas.
- **Versão de formato explícita** — permite evoluir o schema sem quebrar arquivos antigos.
- **Viewport opcional na importação** — o mapa abre enquadrado mesmo se o arquivo vier de outra tela.

### 4.3 Renderização

| Opção | Prós | Contras | Veredito |
| --- | --- | --- | --- |
| **SVG** | Edição de texto via overlay HTML, hit testing por elemento, acessibilidade, CSS para estados | Muitos nós podem pesar no DOM | Escolhido para o v1 |
| Canvas 2D | Ótimo para milhares de elementos | Hit testing manual, texto e edição mais trabalhosos, acessibilidade difícil | Bom para uma v2 de alto desempenho |
| WebGL | Escala muito alta | Complexidade desproporcional | Fora de escopo |

Detalhes que fazem diferença na prática:

- **Medição de texto com `canvas.measureText`** permite dimensionar os nós e quebrar linhas sem depender de bibliotecas.
- **Grid via `background-image: radial-gradient`** no palco, com `background-size` e `background-position` atualizados no pan/zoom — mais barato que desenhar o grid no SVG.
- **Z-order:** arestas → nós → rascunho de conexão. O rascunho precisa ficar por cima para acompanhar o cursor.
- **Arestas com curva Bézier** e seta calculada no ponto de entrada do nó evitam que a linha “atravesse” o cartão.

### 4.4 Interação

- **Pointer Events** (`pointerdown`/`pointermove`/`pointerup`) em vez de mouse + touch separados. Funciona com mouse, caneta e toque; `touch-action: none` evita rolagem acidental.
- **Máquina de estados explícita:** `idle`, `pan`, `drag`, `link`. Cada modo sabe o que fazer no movimento e no fim do gesto.
- **Não usar `setPointerCapture` no nó que é reconstruído.** Listeners globais na `window` sobrevivem à re-renderização; captura de ponteiro em elemento removido do DOM se perde.
- **Hit testing híbrido:** para arestas, um `<path>` invisível com `stroke-width` maior e `pointer-events: stroke`; para “soltar sobre qual nó”, `document.elementFromPoint` + `closest('[data-node-id]')`.
- **Edição de texto com `<textarea>` sobreposto**, posicionado em coordenadas de tela e dimensionado com o zoom; Enter confirma, Shift+Enter quebra linha, Esc cancela. Editar texto dentro do SVG com `contenteditable` é mais frágil entre navegadores.
- **Criação de conexão por alça + Shift+arrastar** — a alça resolve o conflito entre “arrastar para mover” e “arrastar para conectar”, que é o principal atrito de UX desse tipo de editor.

### 4.5 Persistência

- **`localStorage`** com `try/catch`: em `file://`, alguns navegadores/modos privados bloqueiam o acesso. O editor deve continuar funcionando em memória e avisar que o salvamento local não está disponível.
- **Autosave com debounce** (≈400 ms) e botão explícito de salvar; o indicador de status mostra a hora do último salvamento.
- **Exportação JSON via `Blob` + `<a download>`** — funciona offline e não precisa de servidor.
- **Importação via `<input type="file">` + `FileReader`**, com validação/normalização (IDs duplicados, arestas órfãs, coordenadas inválidas) e mensagem de erro legível.
- **Desfazer/refazer por snapshots da topologia** (até 100 estados): simples, previsível e independente do formato de renderização.

### 4.6 Acessibilidade e qualidade

- Alvos de clique generosos (≥ 34 px), foco visível, `aria-label` nos botões somente-ícone, `role="status"`/`aria-live` nos avisos.
- `prefers-reduced-motion` desliga transições.
- Atalhos de teclado cobrindo o fluxo principal (criar, editar, mover, apagar, desfazer, salvar, zoom).
- Estado vazio com instrução, em vez de tela em branco.

### 4.7 Testes

1. **Sintaxe:** extrair o `<script>` inline para um arquivo temporário e rodar `node --check`.
2. **Fumaça em navegador real:** Playwright/Chromium abrindo `file:///.../index.html` e exercitando criar, editar, arrastar, conectar, apagar, desfazer, salvar/recarregar, pan, zoom, exportar e importar.
3. **Matriz manual:** Chrome/Edge, Firefox e Safari; janela estreita; zoom do sistema em 200%; modo privado para verificar o aviso de `localStorage`.

### 4.8 Evolução natural

- **v2:** outline sincronizado, autolayout de árvore, imagens/links, múltiplos mapas por navegador, busca.
- **v3:** colaboração exige backend (WebSocket + CRDT ou OT), autenticação e resolução de conflitos — não é um incremento de arquivo único.
- **IA:** manter um formato de importação estável e deixar a geração do lado de fora; um “mapa colado” em JSON já resolve o caso de uso sem acoplar o editor a um provedor.

## 5. O que foi verificado e o que ficou por verificar

**Método.** O acesso à web disponível incluiu busca **e** leitura direta de páginas oficiais (requisições HTTP seguidas de extração de texto), consulta à API do GitHub para licenças e ao registro npm para dependências. Como a leitura de página estava disponível, **não foi necessário delegar a leitura a um subagente**. Data das consultas: 2026-11-04.

**Verificado em fonte primária:**

- Licenças e linguagem principal dos repositórios: Freeplane (GPL-2.0, Java), draw.io (Apache-2.0, JavaScript), markmap (MIT, TypeScript) e JSON Canvas (MIT) — via API do GitHub.
- Dependência do markmap de `d3` — via registro npm (`markmap-view`, licença MIT).
- Posicionamento e recursos declarados nas páginas oficiais de Xmind (IA, estruturas visuais, colaboração, integrações), MindMeister (colaboração em tempo real, IA, plano gratuito com 3 mapas), Miro (canvas com IA, mapa mental), Whimsical (IA, mapas, fluxos, wireframes), Coggle (colaboração, fluxogramas) e draw.io (grátis, código Apache-2.0, sem armazenamento no servidor).
- Existência de integração de IA e servidor MCP no Freeplane — via documentação oficial.
- Especificação e intenção do JSON Canvas como formato aberto de canvas — via anúncio e repositório oficiais.

**Não verificado / sujeito a mudança:**

- **Preços e limites exatos dos planos** (páginas dinâmicas mudam com frequência); a tabela descreve apenas o modelo (freemium/assinatura) e limites citados oficialmente.
- **Detalhes internos de stack dos produtos fechados** (versão de Electron, frameworks de UI). O que está na tabela é o que as empresas documentam publicamente ou apresentam em talks; “Electron” em Xmind/draw.io desktop é indicativo, não uma garantia contratual.
- **Desempenho comparativo** (número de nós antes de degradar) — não foram feitos benchmarks; as afirmações são qualitativas.
- **Participação de mercado** — não foi medida; a lista foi escolhida por relevância e diversidade de modelo (aberto/fechado, desktop/web, mapa dedicado/canvas).

## 6. Fontes

- Xmind — site oficial e recursos: <https://xmind.app/> · planos: <https://xmind.app/pricing/>
- MindMeister — site oficial: <https://www.mindmeister.com/> · planos: <https://www.mindmeister.com/pricing>
- Miro — mapa mental: <https://miro.com/mind-map/>
- Whimsical — mapas mentais: <https://whimsical.com/mind-maps>
- Coggle — site oficial: <https://coggle.it/> · formatos de exportação: <https://coggle.help/article/105-supported-export-formats>
- Freeplane — site: <https://www.freeplane.org/> · documentação (inclui IA/MCP): <https://docs.freeplane.org/> · repositório: <https://github.com/freeplane/freeplane>
- draw.io — site: <https://www.drawio.com/> · sobre/licença: <https://www.drawio.com/docs/about/> · repositório: <https://github.com/jgraph/drawio>
- markmap — site: <https://markmap.js.org/> · repositório: <https://github.com/markmap/markmap> · pacote: <https://www.npmjs.com/package/markmap>
- JSON Canvas (formato aberto para canvas): <https://obsidian.md/blog/json-canvas/> · especificação: <https://github.com/obsidianmd/jsoncanvas>
- MDN — Pointer Events: <https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events>
- MDN — `localStorage`: <https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage>
- MDN — SVG: <https://developer.mozilla.org/en-US/docs/Web/SVG>

## 7. Como o protótipo v1 se posiciona

| Recurso do pedido | Decisão no `index.html` |
| --- | --- |
| Criar nó com duplo clique | Implementado; o nó nasce já em edição |
| Editar texto com duplo clique | Implementado com `<textarea>` sobreposto |
| Arrastar nós | Implementado com Pointer Events |
| Conectar dois nós | Alça azul no nó ou Shift + arrastar |
| Selecionar e apagar nó/conexão | `Delete`/`Backspace`, com remoção das arestas ligadas |
| Pan e zoom | Arrastar o fundo; roda do mouse centrada no cursor |
| Salvar/carregar em `localStorage` | Autosave + botões explícitos + indicador de status |
| Exportar/importar JSON | `Blob`/`FileReader`, com validação do schema |
| Atalhos | `Tab`, `Enter`/`F2`, setas, `Ctrl+Z`/`Ctrl+Shift+Z`, `Ctrl+S`, `Ctrl+0`, `+`/`-`, `Esc` |
| Sem build step | Arquivo único, sem CDN/npm; validado com `node --check` e teste de fumaça em Chromium |

Limitações conscientes do v1: sem colaboração, sem IA embutida, sem múltiplos mapas nomeados, sem imagens/embeds e sem gesto de pinça em telas de toque. São extensões compatíveis com o modelo de dados, mas exigem mais trabalho (e, no caso de colaboração, um backend).
