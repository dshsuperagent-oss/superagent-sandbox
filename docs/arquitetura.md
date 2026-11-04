# Arquitetura do editor de mapas mentais

Este documento explica como o `index.html` está organizado, por que ele continua
sendo um arquivo único e onde mexer para adicionar um recurso. Para o uso do dia
a dia, veja o [tutorial](tutorial.md).

## 1. Princípios e restrições

O editor é deliberadamente um **arquivo único** com HTML, CSS e JavaScript
inline. As restrições que guiam as decisões:

- abre direto de `file://`, sem servidor e sem instalação;
- zero dependências de runtime: nada de CDN, fontes externas, npm ou build;
- nenhum módulo ES, `fetch` ou importação dinâmica (que falham ou exigem
  configuração em `file://`);
- o estado inteiro vive em `localStorage` e em memória;
- o código é legível sem transpilação e pode ser validado com `node --check`.

O preço é um arquivo maior e a necessidade de disciplina manual na separação das
seções. Em troca, o editor é portátil: basta copiar `index.html`.

## 2. Mapa do arquivo

O `index.html` tem quatro blocos:

1. **`<head>` e `<style>`** — variáveis visuais, barra de ferramentas, barra de
   mapas, painel de estrutura, palco SVG, nós, conexões, editor de texto, toast,
   modal de ajuda e regras responsivas.
2. **`<body>` / HTML** — estrutura fixa:
   - `#app`: coluna com `header.toolbar`, `.mapbar`, `main.workspace` e
     `footer.statusbar`;
   - `.workspace`: `aside#outline` + `div#stage`;
   - `#stage`: `svg#canvas` (com `#world`, `#edgeLayer`, `#nodeLayer`,
     `#draftLayer`), `#emptyHint`, `#editor` e `#toast`;
   - `#help` (modal) e `#importFile` (input de arquivo escondido).
3. **`<script>`** — um IIFE em modo estrito. Todo o estado e as funções são
   locais; só `window.__mindmap` é exposto, para testes e medição.
4. **Dados** — nenhum arquivo adicional é necessário para rodar. `docs/` e
   `tests/` são documentação e ferramentas de desenvolvimento.

Camadas SVG:

- `#edgeLayer`: uma `<g class="edge" data-edge-id="...">` por conexão, com três
  `<path>` (área de clique, traço visível e seta);
- `#nodeLayer`: uma `<g class="node" data-node-id="...">` por nó, com `<rect>`,
  `<text>` (um `<tspan>` por linha) e a alça de conexão;
- `#draftLayer`: apenas a conexão em rascunho durante o arraste.

## 3. Modelo de dados

### Workspace, mapas, nós e conexões

Em memória, `workspace` é:

```js
{
  formatVersion: 2,
  activeId: 'm-...',
  maps: [
    {
      id: 'm-...',
      name: 'Mapa mental',
      createdAt: '...',
      updatedAt: '...',
      viewport: { x: 0, y: 0, scale: 1 },
      nodes: [{ id: 'n-...', text: '...', x: 0, y: 0 }],
      edges: [{ id: 'e-...', from: 'n-...', to: 'n-...' }]
    }
  ]
}
```

`doc` aponta para o mapa ativo (o mesmo objeto dentro de `workspace.maps`).
`pan` e `scale` são a câmera atual; ela é sincronizada de volta no `viewport` do
mapa ao trocar de mapa e ao montar o snapshot de persistência.

- `nodes[].x` / `nodes[].y` são o **centro** do nó em unidades de mundo.
- `edges[]` são direcionadas (`from` → `to`); o editor não impõe que o grafo seja
  uma árvore.
- Texto é limitado a 1000 caracteres por nó; a renderização limita a oito linhas.

### Chaves de armazenamento

- `mindmap-editor:v2`: workspace completo (todos os mapas).
- `mindmap-editor:v1`: dados da v1, lidos apenas na migração e mantidos como
  cópia de segurança.

A migração acontece em `loadWorkspace()`: se a chave v2 não existe, a chave v1 é
lida, normalizada e transformada em um mapa chamado “Mapa mental”. A v1 não é
apagada. Se nenhuma das duas existe, um mapa de exemplo é criado.

### Validação e normalização

- `normalizeDoc(raw)` valida `nodes`/`edges`, remove IDs duplicados, posições não
  finitas, auto-conexões e conexões duplicadas.
- `normalizeViewport(raw)` limita a escala entre `MIN_SCALE` e `MAX_SCALE`.
- `normalizeWorkspace(raw)` aceita o formato v2 (com `maps`) ou um único mapa
  (com `nodes`) e ignora mapas individuais inválidos, preservando os válidos.

### Formato de exportação

`snapshotMap()` gera o JSON de **um mapa** com `formatVersion: 1`, mantendo
compatibilidade com a v1 e acrescentando `name`. O conjunto de mapas nunca é
exportado junto: exportar/importar trabalha com um mapa por arquivo.

## 4. Renderização

### Render completo

`renderAll()` é chamado em mudanças estruturais ou de texto (criar, apagar,
conectar, importar, desfazer, renomear, trocar de mapa e autolayout). Ele:

1. incrementa `metrics.fullRenders`;
2. reconstrói `layout` (tamanho e linhas de cada nó, via canvas de medição);
3. reconstrói `#edgeLayer` e `#nodeLayer` com `DocumentFragment`;
4. atualiza o rascunho, a barra de status, o painel de estrutura e a câmera.

`layout` é um `Map<id, { w, h, lines }>` mantido em memória. A medição de texto
usa um `<canvas>` 2D, não o DOM, para não forçar layout.

### Atualizações direcionadas

As interações de alta frequência **não** chamam `renderAll()`:

| Interação | O que muda |
| --- | --- |
| arrastar nó | `transform` do nó + geometria das conexões incidentes |
| pan | `transform` de `#world` e posição do fundo |
| zoom | `transform` de `#world` e posição do fundo |
| criar conexão (arraste) | apenas os `d` do rascunho e a classe de destaque |
| selecionar | apenas classes `selected` |
| mover com setas | `transform` do nó + conexões incidentes |

Os mapas de DOM `nodeEls`, `edgeEls` e o índice `edgesByNode` permitem atualizar
só o necessário. `updateNodeTransform()` e `updateEdgeElement()` são as funções
de atualização pontual; `updateEdgesForNode()` usa o índice para não varrer todas
as conexões.

### `requestAnimationFrame` e leitura de layout

`pointermove` apenas registra a última posição e marca uma flag
(`pending.drag`, `pending.link`, `pending.view`). `requestFrame()` agenda um
único `requestAnimationFrame`; `flushFrame()` aplica as escritas. Vários eventos
no mesmo frame viram uma atualização só.

A posição do SVG é lida uma vez por gesto com `stageRect()` e guardada em
`rectCache`; `invalidateRect()` é chamado em resize e ao abrir/fechar o painel.
Assim, o caminho do arraste não intercala `getBoundingClientRect()` com escritas
de estilo. A conversão cliente → mundo usa `clientToWorld()`, que consulta esse
cache.

O teste de fumaça pode verificar isso pelo comportamento; a medição usa
`tests/measure.cjs`.

### Métricas de depuração

`window.__mindmap` expõe:

```js
window.__mindmap.resetMetrics();
window.__mindmap.metrics;   // fullRenders, nodeUpdates, edgeUpdates, draftUpdates, storageWrites
window.__mindmap.history(); // { length, index, limit, bytes }
window.__mindmap.state();   // { map, maps, nodes, edges, scale, pan }
```

É uma API pequena, sem efeito no comportamento normal, usada por
`tests/measure.cjs` e disponível no console para investigar desempenho.

## 5. Eventos e edição

### Máquina de estados do ponteiro

`mode` pode ser `idle`, `pan`, `drag` ou `link`.

1. `pointerdown` (no `svg`):
   - alça → `startLink()`;
   - nó → seleciona e inicia `startDrag()` (ou `startLink()` com `Shift`);
   - conexão → seleciona;
   - fundo → limpa a seleção e inicia `startPan()`.
2. `pointermove` (na `window`) atualiza a última posição e agenda o frame.
3. `pointerup`:
   - arraste com movimento → `pushHistory()` e `scheduleSave()`;
   - conexão com destino válido → `connect()`;
   - pan com movimento → `scheduleSave()`.

O `flushPending()` garante que o `pointerup` use a posição final, mesmo que o
`requestAnimationFrame` ainda não tenha rodado.

Durante a conexão, o alvo é calculado por `nodeAtWorld()` usando as caixas do
`layout`, sem `document.elementFromPoint()` e sem leitura de layout por evento.
O destaque só muda quando o alvo muda (`lastHighlight`).

### Edição de texto

`startEditing()` mostra o `<textarea>` sobre o nó, com fonte e posição derivadas
de `pan`/`scale`/`layout`. `commitEditing()` normaliza o texto (apara linhas,
remove vazias nas pontas), registra histórico e agenda salvamento. `Esc` chama
`cancelEditing()`. O `blur` do textarea confirma a edição.

### Teclado

`onKeyDown` ignora eventos quando o foco está em `input`, `select` ou `textarea`
e quando o modal de ajuda está aberto. As teclas de edição do nó só valem com um
nó selecionado. O editor de texto tem seu próprio `onEditorKeyDown`, que para a
propagação para não acionar atalhos globais.

## 6. Persistência

`safeGet`/`safeSet` isolam o acesso ao `localStorage` em `try/catch`. Se o
navegador bloquear, `storageOK` vira `false`, a barra de status mostra “sem
armazenamento local” e o editor continua em memória; exportar/importar continua
funcionando.

`scheduleSave()` usa um debounce de **500 ms**. `saveNow()`:

1. monta uma assinatura do workspace (`workspaceSignature()`) sem timestamps;
2. compara com `lastSaved`; se nada mudou, não reescreve;
3. caso contrário, grava `snapshotWorkspace()` e atualiza `lastSaved`.

O debounce evita gravação a cada movimento; a assinatura evita reescrever o mesmo
conteúdo em cliques repetidos em **Salvar**. `pagehide` e
`visibilitychange` tentam gravar o estado pendente ao sair/ocultar a aba.

`lastSaved` é uma assinatura, não o JSON completo, para reduzir memória.

## 7. Histórico

O histórico é por mapa ativo, em memória (não persiste no `localStorage`). Cada
entrada é um snapshot **compacto**:

```js
{ n: [[id, texto, x, y], ...], e: [[id, from, to], ...] }
```

`pushHistory()` compara a chave serializada com a entrada atual, corta o futuro
(ramo desfeito), empilha e limita a `HISTORY_LIMIT` (50). `restoreHistory()`
reconstrói `doc.nodes`/`doc.edges` a partir das tuplas e chama `renderAll()`.
`undo()`/`redo()` apenas movem o índice e restauram.

Ao trocar de mapa, `activateMap()` cria o histórico inicial daquele mapa se ainda
não existir; ao excluir, `histories.delete(id)` libera a memória. Isso evita que
o desfazer de um mapa altere outro.

Os números de tamanho de snapshot e a comparação com a v1 estão em
`tests/measure.cjs` e no PR da v2.

## 8. Recursos da v2

### Autolayout de árvore

`organizeLayout()`:

1. pede confirmação (as posições manuais serão substituídas; `Ctrl+Z` desfaz);
2. monta `children` a partir das conexões, ordenando os filhos pela posição
   vertical/horizontal atual;
3. encontra raízes (nós sem conexão de entrada) e, depois, qualquer nó ainda não
   visitado (componentes separados/ciclos), formando uma floresta;
4. `measureTree()` calcula a altura de cada subárvore: folha = altura do nó;
   pai = soma das subárvores + `V_GAP`, com no mínimo a própria altura;
5. calcula `levelX` usando a maior largura de cada nível + `H_GAP`, garantindo
   que níveis não se sobreponham;
6. `placeTree()` distribui cada subárvore verticalmente e centraliza o pai sobre
   os filhos; raízes são empilhadas com `ROOT_GAP`;
7. registra histórico e chama `fitView(false)` para enquadrar o resultado.

Ciclos não entram na árvore de posicionamento (o `seen` evita loops), mas as
conexões continuam desenhadas. Como a confirmação avisa e o histórico guarda o
estado anterior, a posição manual não é destruída sem aviso e pode ser desfeita.

### Painel de estrutura

`buildOutline()` monta `byId`, `children` e `roots` do mesmo jeito que o
autolayout, mas mantém todos os nós. `renderOutline()` cria as linhas com:

- botão de expandir/recolher (`outlineCollapsed`);
- botão de rótulo (`centerNode()`);
- botão de renomear (`beginOutlineRename()`).

`centerNode()` ajusta `pan` para colocar o centro do nó no centro do palco e
seleciona o nó. O painel é reconstruído em `renderAll()`; durante arraste/pan ele
não é recriado. Em telas estreitas, ele é uma gaveta posicionada por CSS e fecha
ao escolher um nó.

### Múltiplos mapas

As operações ficam em `newMap()`, `duplicateMap()`, `renameMap()`, `deleteMap()`,
`selectMap()` e `activateMap()`.

- `newMap()` cria um mapa vazio com `nextMapName()`.
- `duplicateMap()` remapeia IDs de nós e conexões para não compartilhar
  identidade com o original.
- `renameMap()` usa `window.prompt` e recusa nomes repetidos.
- `deleteMap()` confirma, remove o histórico do mapa e, se necessário, garante um
  mapa vazio.
- `activateMap()` salva o `viewport` do mapa anterior, carrega o novo, limpa
  seleção/edição/gesto e redesenha.
- `renderMapSelect()` mantém o `<select>` e o contador de mapas sincronizados.

## 9. Onde mexer para adicionar um recurso

Use esta ordem para não esquecer nenhuma parte:

1. **HTML/CSS**: adicione o controle (botão, painel, campo) em
   `header.toolbar`, `.mapbar`, `.workspace` ou no modal de ajuda. Use os
   elementos existentes como referência de estilo.
2. **Elementos e estado**: registre o elemento no bloco “Elementos” do script e,
   se o recurso tiver estado próprio, crie variáveis no bloco “Estado”.
3. **Modelo**: se o recurso altera nós/conexões/mapas, atualize
   `normalizeDoc`/`snapshotMap`/`snapshotWorkspace` e a exportação/importação
   para o dado sobreviver a recarregar e exportar.
4. **Render**: se o dado aparece no mapa, atualize `renderAll()` (e os
   `renderNodes`/`renderEdges` correspondentes). Se for interação de alta
   frequência, prefira atualização pontual (como `updateNodeTransform`) a
   recriar a camada.
5. **Eventos**: adicione o listener em `bindEvents()`, cuidando para não
   conflitar com `pointerdown`/`pointermove`/`pointerup` e com os atalhos
   globais. Se o foco estiver em um campo, o `onKeyDown` já ignora.
6. **Ações e histórico**: implemente a ação como função (por exemplo,
   `connect`, `nudge`), mutando `doc`, chamando `pushHistory()` e
   `scheduleSave()` na ordem correta.
7. **Persistência**: se o estado precisa sobreviver ao reload, inclua-o em
   `workspaceSignature()` e `snapshotWorkspace()`. Se for estado de UI efêmero,
   não inclua.
8. **Acessibilidade**: dê `aria-label`/`title` aos botões e mantenha o foco
   visível; o painel usa `role="tree"`/`treeitem`.
9. **Testes e documentação**: acrescente um cenário em `tests/smoke.cjs`,
   atualize `tests/measure.cjs` se o recurso afetar desempenho, gere novas
   capturas com `tests/capture.cjs` e atualize o tutorial e o README.

### Exemplo curto: “marcar nó como concluído”

1. No modelo, `node.done = true/false`; valide em `normalizeDoc` e serialize em
   `snapshotMap`/`snapshotWorkspace`.
2. Em `renderNodes()`, adicione a classe `done` (e o CSS correspondente).
3. Em `bindEvents()`, um listener de clique/tecla chama `toggleDone()`, que muta
   `doc`, chama `pushHistory()`, `scheduleSave()` e atualiza só a classe do nó
   (`nodeEls.get(id)`), sem `renderAll()`.
4. Inclua o campo em `topologyData()` para o desfazer/refazer.
5. Adicione um cenário no smoke test e uma captura no tutorial.

## 10. Verificação e medição

### Sintaxe sem navegador

```bash
python3 - <<'PY'
import re
html = open('index.html', encoding='utf-8').read()
open('/tmp/editor-script.js', 'w', encoding='utf-8').write(re.search(r'<script>(.*?)</script>', html, re.S).group(1))
PY
node --check /tmp/editor-script.js
```

### Teste de fumaça em Chromium

```bash
npm install --no-save playwright
npx playwright install chromium
node tests/smoke.cjs
```

O teste cobre autolayout (confirmação, ausência de sobreposição, undo), painel de
estrutura (seleção, renomear, recolher/expandir), múltiplos mapas (criar,
renomear, duplicar, trocar, excluir, recarregar), criar/editar/conectar,
exportar/importar e o cenário de `localStorage` bloqueado. Ele falha se houver
erro de console ou `pageerror`.

### Medição antes/depois

```bash
git show 68c3560:index.html > /tmp/index-v1.html
node tests/measure.cjs --baseline /tmp/index-v1.html
```

O script usa um mapa de 150 nós/149 conexões, arrasta o nó raiz com 60 eventos
`pointermove` no mesmo frame e conta mutações DOM, leituras de layout, tempo,
escritas no `localStorage`, renderizações completas e tamanho do histórico. Os
números da v2 estão no PR.

### Capturas reais

```bash
node tests/capture.cjs --baseline /tmp/index-v1.html
```

Gera `docs/img/v2-antes-editor.png`, `docs/img/v2-depois-editor.png` e as imagens
`docs/img/tutorial-*.png` usadas no tutorial. As capturas foram feitas no próprio
ambiente com Playwright/Chromium, em 1440×900, tema claro.

## 11. Limitações e decisões conscientes

- **Sem virtual DOM**: com algumas centenas de nós, atualizar SVG direto com
  mapas de elementos é mais simples e rápido do que introduzir uma biblioteca.
- **Sem persistência do histórico**: refazer/desfazer é por aba e por mapa; ao
  recarregar, o histórico recomeça.
- **Snapshot compacto, não comandos**: o histórico guarda tuplas, não diffs
  operationais. É simples e previsível; o limite de 50 controla a memória.
- **Autolayout é uma floresta derivada do grafo**: conexões extras/ciclos não
  determinam posição. O aviso antes de organizar e o undo cobrem a substituição
  das posições manuais.
- **`localStorage` é por navegador/arquivo**: não há sincronização entre
  dispositivos; exportar/importar é o caminho de backup.
- **Um mapa por arquivo exportado**: o workspace com vários mapas fica no
  navegador; a exportação escolhe o mapa ativo.
- **Sem colaboração, imagens, embeds ou pinça**: fora do escopo desta iteração.

## 12. Referências

- [Tutorial do usuário](tutorial.md)
- [Pesquisa que embasou a v1](pesquisa-mapas-mentais.md)
- [README](../README.md)
