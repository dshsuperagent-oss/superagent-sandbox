# superagent-sandbox

Repo sandbox para testes do dsh-superagent (nao usar para trabalho real)

## Editor de mapas mentais

Protótipo v1 em **arquivo único**: [`index.html`](index.html) reúne HTML, CSS e JavaScript puro, sem CDN, sem npm e sem build step.

![Editor de mapas mentais em funcionamento](docs/img/depois-editor.png)

### Como abrir

1. Baixe ou clone o repositório.
2. Dê um duplo clique em `index.html` — ou arraste o arquivo para uma aba do navegador.
3. Não é preciso servidor: o editor funciona direto de `file://`.

Funciona melhor em versões recentes de Chrome, Edge, Firefox e Safari.

Na primeira abertura o editor carrega um mapa de exemplo para demonstrar os recursos. Use **Novo** para começar do zero.

### Como usar

- **Criar nó:** duplo clique em qualquer lugar do fundo.
- **Editar texto:** duplo clique no nó. `Enter` confirma, `Shift+Enter` quebra linha e `Esc` cancela.
- **Mover nó:** arraste o nó.
- **Criar conexão:** arraste a alça azul (o `+` que aparece no nó selecionado) até outro nó — ou use `Shift` + arrastar o nó.
- **Selecionar e apagar:** clique no nó ou na conexão e pressione `Delete` (ou `Backspace`). Apagar um nó remove também as conexões ligadas a ele.
- **Pan:** arraste o fundo do mapa.
- **Zoom:** use a roda do mouse (o zoom acontece no ponto do cursor) ou os botões `−` / `+`.
- **Salvar e carregar:** o mapa é salvo automaticamente em `localStorage`; os botões **Salvar** e **Carregar** forçam a operação.
- **Exportar e importar JSON:** **Exportar** baixa `mapa-mental.json`; **Importar** abre um arquivo exportado anteriormente.
- **Ajuda:** o botão `?` na barra de ferramentas abre a lista completa de atalhos.

### Atalhos de teclado

| Atalho | Ação |
| --- | --- |
| `Tab` | Cria um nó filho conectado ao nó selecionado |
| `Enter` ou `F2` | Edita o nó selecionado |
| Setas | Move o nó selecionado 8 px (`Shift` move 1 px) |
| `Delete` / `Backspace` | Apaga o nó ou a conexão selecionada |
| `Ctrl/Cmd + Z` | Desfaz |
| `Ctrl/Cmd + Shift + Z` | Refaz |
| `Ctrl/Cmd + S` | Salva neste navegador |
| `Ctrl/Cmd + 0` | Ajusta a visualização ao conteúdo |
| `+` / `−` | Zoom |
| `Esc` | Cancela a edição, limpa a seleção ou fecha a ajuda |

### Formato do JSON

O arquivo exportado é legível e versionado:

```json
{
  "formatVersion": 1,
  "app": "editor-de-mapas-mentais",
  "updatedAt": "2026-11-04T02:00:00.000Z",
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

- `nodes[].x` / `nodes[].y` são o **centro** do nó, em unidades de mundo.
- `edges[]` são dirigidas (`from` → `to`), mas o editor não impõe hierarquia.
- `viewport` é opcional na importação; se estiver ausente, o mapa é enquadrado automaticamente.

### Limitações do protótipo

- Os dados ficam apenas no navegador usado (cada navegador/arquivo tem seu próprio `localStorage`). Para backup ou para trocar de máquina, exporte o JSON.
- Alguns navegadores bloqueiam `localStorage` em `file://` ou em modo privado. Nesse caso o editor continua funcionando em memória e avisa que o salvamento local não está disponível — use **Exportar** / **Importar**.
- Sem colaboração em tempo real, sem IA embutida, sem imagens/embeds, sem múltiplos mapas nomeados e sem gesto de pinça em telas de toque.
- O editor foi pensado para mapas pequenos e médios (algumas centenas de nós). Acima disso, a renderização em SVG pode ficar menos fluida.

### Testes

O JavaScript inline pode ser validado sem abrir o navegador:

```bash
python3 - <<'PY'
import re
html = open('index.html', encoding='utf-8').read()
open('/tmp/editor-script.js', 'w', encoding='utf-8').write(re.search(r'<script>(.*?)</script>', html, re.S).group(1))
PY
node --check /tmp/editor-script.js
```

O protótipo também foi exercitado em Chromium via Playwright (criar, editar, arrastar, conectar, apagar, desfazer, salvar/recarregar, pan, zoom, exportar e importar).

## Pesquisa

O levantamento que embasou as decisões está em [`docs/pesquisa-mapas-mentais.md`](docs/pesquisa-mapas-mentais.md): comparação de 8 ferramentas, os 5 recursos que mais diferenciam as soluções atuais e a arquitetura recomendada para um editor web sem build step.

## Ferramentas

- [`tools/puzzle-monitor/`](tools/puzzle-monitor/README.md) — CLI passivo e somente leitura que acompanha endereços públicos de puzzles de Bitcoin (saldo confirmado, número de transações e mudanças entre snapshots). Funciona online (mempool.space ou blockstream.info) e offline com fixtures; não gera chaves, não assina e não transmite transações.
- [`docs/pesquisa-cripto-perdida.md`](docs/pesquisa-cripto-perdida.md) — relatório técnico e jurídico sobre criptomoedas "perdidas sem dono": por que chaves perdidas são irrecuperáveis, o que cada categoria permite e por que se apropriar de cripto de terceiros pode ser crime no Brasil.

O monitor não reivindica nem move fundos: ele apenas observa dados públicos. A conclusão do relatório é explícita — não existe caminho legítimo para "achar" criptomoeda de terceiros e ficar com ela.
