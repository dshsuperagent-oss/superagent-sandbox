# Scene-spec v1 — contrato JSON do Blender Director

Este documento descreve o schema v1 aceito por `POST /jobs` e pelos comandos
incrementais em `POST /jobs/:id/commands`. O schema é **estável dentro da
versão 1**: campos documentados aqui são validados; campos desconhecidos são
rejeitados com erro explícito para pegar erros de digitação cedo.

- Implementação da validação: [`lib/spec.js`](lib/spec.js)
- Consumo no Blender: [`build.py`](build.py)
- Exemplos prontos: [`examples/`](examples/)
- Manifesto gerado: [`manifest.json`](#manifesto) (por job)

## Sumário

1. [Convenções](#convenções)
2. [Cena completa](#cena-completa)
3. [Campos de topo](#campos-de-topo)
4. [Objetos](#objetos)
5. [Materiais](#materiais)
6. [Luzes](#luzes)
7. [Câmera, mundo, render e saída](#câmera-mundo-render-e-saída)
8. [Comandos incrementais](#comandos-incrementais)
9. [Limites e erros](#limites-e-erros)
10. [Manifesto](#manifesto)
11. [Versão e compatibilidade](#versão-e-compatibilidade)

## Convenções

| Dado | Formato | Observação |
| --- | --- | --- |
| Comprimento | metros | Escala real é pré-requisito de fotorrealismo; um cubo de 1 m é um cubo de 1 m. |
| Rotação | graus | Convertida para radianos no `build.py`. |
| Cor | `"#rrggbb"` (sRGB) ou `[r,g,b]` linear | Hex é convertido para linear; arrays são tratados como lineares (o que o Principled BSDF espera). |
| Energia de luz | watts | Para `SUN`, o Blender interpreta `energy` como irradiância (W/m²). |
| Resolução | `[largura, altura]` | O render final usa exatamente esse par; o preview é reduzido por `preview.maxSize`. |
| Samples | inteiro | `samples` é o final; `preview.samples` é o preview. |
| Tempo | segundos | Métricas e logs; o manifesto guarda `seconds` por estágio. |

O servidor normaliza o spec antes de gravar `runs/<job>/spec.json`. O arquivo
normalizado é o que o `build.py` lê; ele contém todos os defaults aplicados.

## Cena completa

Exemplo mínimo, porém completo, com primitiva, malha customizada, modificador,
três luzes e câmera com DOF:

```json
{
  "schemaVersion": 1,
  "name": "Cena de exemplo",
  "engine": "CYCLES",
  "samples": 128,
  "resolution": [1200, 800],
  "preview": { "maxSize": 640, "samples": 32 },
  "colorManagement": { "viewTransform": "AgX", "look": "None", "exposure": 0 },
  "render": { "device": "GPU", "adaptive": true, "denoise": true, "maxBounces": 8 },
  "camera": {
    "location": [4, -4, 2.6],
    "target": [0, 0, 0.8],
    "lens": 50,
    "sensorWidth": 36,
    "fstop": 4,
    "focus": "target"
  },
  "world": { "color": "#101014", "strength": 0.5, "hdri": null },
  "materials": {
    "piso": {
      "baseColor": "#2a2a2e",
      "metallic": 0,
      "roughness": 0.4
    },
    "metal": {
      "baseColor": "#c9a86a",
      "metallic": 1,
      "roughness": 0.2,
      "anisotropy": 0.3,
      "normal": { "type": "bump", "strength": 0.08, "scale": 60 }
    }
  },
  "objects": [
    {
      "name": "piso",
      "primitive": "plane",
      "transform": { "loc": [0, 0, 0], "scale": [10, 10, 1] },
      "material": "piso"
    },
    {
      "name": "cubo",
      "primitive": "cube",
      "transform": { "loc": [-0.8, 0, 0.5], "rot": [0, 0, 20] },
      "material": "metal",
      "modifiers": [{ "type": "bevel", "width": 0.02, "segments": 3 }]
    },
    {
      "name": "malha",
      "mesh": {
        "verts": [[0, 0, 1.2], [1, 0, 0.2], [0, 1, 0.2], [-1, -1, 0.2]],
        "faces": [[0, 1, 2], [0, 2, 3], [0, 3, 1], [1, 3, 2]]
      },
      "transform": { "loc": [0.9, 0.1, 0.2], "scale": [0.6, 0.6, 0.6] },
      "material": "metal",
      "smooth": true
    }
  ],
  "lights": [
    {
      "name": "key",
      "type": "AREA",
      "position": [3, -2.5, 3.5],
      "energy": 450,
      "size": 2,
      "color": "#fff0dd",
      "target": [0, 0, 0.8]
    },
    {
      "name": "fill",
      "type": "AREA",
      "position": [-3.5, -1, 2.2],
      "energy": 120,
      "size": 3,
      "color": "#cfe0ff",
      "target": [0, 0, 0.8]
    },
    {
      "name": "rim",
      "type": "SPOT",
      "position": [0, 3.5, 3],
      "energy": 350,
      "size": 0.5,
      "color": "#ffd6b0",
      "target": [0, 0, 0.9],
      "spotSize": 45,
      "spotBlend": 0.3
    }
  ],
  "output": { "format": "PNG", "transparent": false }
}
```

Esse exemplo é estruturalmente equivalente aos arquivos em
[`examples/`](examples/), que são exercitados pelo e2e no modo fixture.

## Campos de topo

| Campo | Tipo | Default | Descrição |
| --- | --- | --- | --- |
| `schemaVersion` | inteiro | `1` | Apenas `1` é aceito nesta versão. |
| `name` | string (≤120) | `"Cena sem nome"` | Nome exibido no viewer e no manifesto. |
| `engine` | `"CYCLES"` \| `"BLENDER_EEVEE_NEXT"` | `"CYCLES"` | `"EEVEE"` é aceito como alias e normalizado para `BLENDER_EEVEE_NEXT`. |
| `samples` | inteiro 1–100000 | `128` | Samples do render final. |
| `resolution` | `[int, int]` | `[1200, 800]` | 64–8192 por eixo e no máximo 50 MP. |
| `preview` | objeto | `{maxSize: 640, samples: 32}` | Preview antes da aprovação. |
| `colorManagement` | objeto | AgX / None / 0 | View transform, look e exposição. |
| `render` | objeto | GPU / adaptativo / denoise / 8 bounces | Configuração do Cycles. |
| `camera` | objeto | ver abaixo | Câmera da cena. |
| `world` | objeto | cor escura, strength 1 | Fundo/HDRI. |
| `objects` | array (1–200) | obrigatório | Geometria da cena. |
| `materials` | objeto (0–64) | `{}` | Materiais por nome. |
| `lights` | array (0–32) | `[]` | Luzes; uma cena com HDRI pode não ter luzes. |
| `output` | objeto | PNG, opaco | Formato e transparência do render final. |

## Objetos

Cada item de `objects` deve ter **ou** `primitive` **ou** `mesh` (nunca os dois).
O nome é único na cena; nomes duplicados são rejeitados.

| Campo | Tipo | Default | Descrição |
| --- | --- | --- | --- |
| `name` | string (≤120) | `objeto_N` | Identificador; usado por boolean e logs. |
| `primitive` | `cube` \| `sphere` \| `cylinder` \| `plane` \| `cone` \| `torus` | — | Primitiva do Blender. |
| `mesh` | `{verts, faces}` | — | Malha explícita. |
| `transform` | `{loc, rot, scale}` | zeros / um | `loc` e `scale` em metros; `rot` em graus. |
| `material` | string | `null` | Precisa existir em `materials`. |
| `modifiers` | array (≤16) | `[]` | Aplicados antes do Geometry Nodes. |
| `geometryNodes` | objeto | `null` | Apenas o preset `scatter` nesta versão. |
| `smooth` | boolean | `false` | Shading suave (útil em esferas/torus). |

### Primitivas e UVs

`cube`, `sphere`, `cylinder`, `plane`, `cone` e `torus` vêm com UVs do Blender.
Malhas customizadas recebem uma projeção planar simples (nome `UVMap`) quando
o objeto é criado, para que texturas de imagem tenham coordenadas utilizáveis.
Escalas não uniformes são aplicadas à malha na criação; modificadores como
bevel passam a trabalhar em unidades de mundo.

### Modificadores

| `type` | Campos | Observações |
| --- | --- | --- |
| `bevel` | `width` (0.0001–10, default 0.02), `segments` (1–12, default 3) | Limita por ângulo (30°). |
| `subsurf` | `levels` (0–6), `renderLevels` (0–6) | Ambos default 2. |
| `boolean` | `target` (nome de outro objeto), `operation` (`DIFFERENCE`\|`UNION`\|`INTERSECT`) | Solver `EXACT`; auto-boolean é rejeitado. |
| `solidify` | `thickness` (0.0001–10, default 0.02), `offset` (-1–1, default -1) | Útil para paredes finas. |
| `array` | `count` (2–1000, default 3), `offset` (`[x,y,z]`, default `[1,0,0]`) | Offset relativo. |

### Malha customizada

```json
{
  "name": "tetra",
  "mesh": {
    "verts": [[0, 0, 1], [1, 0, 0], [0, 1, 0], [-1, -1, 0]],
    "faces": [[0, 1, 2], [0, 2, 3], [0, 3, 1], [1, 3, 2]]
  },
  "transform": { "loc": [0, 0, 0], "rot": [0, 0, 0], "scale": [1, 1, 1] }
}
```

Índices de face precisam existir em `verts`; faces com menos de 3 vértices são
rejeitadas. O total de vértices customizados é limitado a 200 mil.

### Geometry Nodes (preset `scatter`)

```json
{
  "geometryNodes": {
    "preset": "scatter",
    "count": 150,
    "radius": 0.03,
    "seed": 7,
    "material": "grama"
  }
}
```

O `build.py` monta um node group com `Distribute Points on Faces` +
`Instance on Points` + `Ico Sphere` + `Set Material`. `count` vira densidade
aproximada (pontos por m² calculados a partir da área da malha base). É o
único preset do schema v1; outros presets são rejeitados. Esse caminho depende
de APIs de Geometry Nodes e deve ser validado no Blender real — o modo fixture
não executa geometria.

## Materiais

Mapa `nome → material`. O `build.py` cria um Principled BSDF e liga as entradas
correspondentes. Nomes de material devem casar com `^[A-Za-z0-9_.-]{1,64}$`.

| Campo | Tipo | Default | Entrada do Principled BSDF |
| --- | --- | --- | --- |
| `baseColor` | cor | `#cccccc` | Base Color |
| `metallic` | 0–1 | `0` | Metallic |
| `roughness` | 0–1 | `0.5` | Roughness |
| `ior` | 1–3 | `1.45` | IOR |
| `transmission` | 0–1 | `0` | Transmission Weight |
| `subsurface` | 0–1 | `0` | Subsurface Weight |
| `coat` | 0–1 | `0` | Coat Weight |
| `sheen` | 0–1 | `0` | Sheen Weight |
| `anisotropy` | -1–1 | `0` | Anisotropic |
| `emission` | `{color, strength}` | preto / 0 | Emission Color + Strength |
| `normal` | objeto ou string | `null` | Normal (bump ou normal map) |
| `textures` | array (≤8) | `[]` | Primeira textura alimenta a Base Color. |

### Texturas

| `type` | Campos principais | Uso |
| --- | --- | --- |
| `noise` | `scale`, `detail`, `roughness`, `distortion`, `color1`, `color2` | Mármore, rugosidade, variação de cor. |
| `voronoi` | `scale`, `color1`, `color2` | Rachaduras, células, padrões orgânicos. |
| `wave` | `scale`, `distortion`, `color1`, `color2` | Tecido, madeira serrada, ondas. |
| `checker` | `scale`, `color1`, `color2` | Teste de UV e contraste. |
| `image` | `path`, `projection` (`flat`\|`box`) | Textura em arquivo local. |

Apenas a **primeira** textura da lista alimenta a Base Color; as demais são
ignoradas com um `warning` no log. Isso é uma limitação consciente do v1: para
mais camadas, o caminho é evoluir o schema ou usar um material no `.blend`.

```json
{
  "baseColor": "#7b2d3a",
  "roughness": 0.85,
  "sheen": 0.5,
  "textures": [
    { "type": "wave", "scale": 22, "distortion": 2, "color1": "#5f202b", "color2": "#913c4b" }
  ]
}
```

### Normal / relevo

```json
{ "type": "bump", "strength": 0.15, "scale": 30 }
```

ou um mapa de normais em arquivo:

```json
{ "type": "image", "path": "textures/normal.jpg", "strength": 0.6 }
```

`path` relativo é resolvido a partir do diretório do `spec.json`. Imagem
ausente gera `warning` e o material continua sem normal map.

## Luzes

| Campo | Tipo | Default | Descrição |
| --- | --- | --- | --- |
| `name` | string | `luz_N` | Nome do objeto de luz. |
| `type` | `POINT` \| `SUN` \| `AREA` \| `SPOT` | obrigatório | Tipo do Blender. |
| `position` | `[x,y,z]` | `[0,0,3]` | Posição em metros. |
| `energy` | ≥0 | `100` (`SUN`: `3`) | Watts (SUN: W/m²). |
| `size` | 0.001–1000 | `1` | Tamanho/raio da área ou softness. |
| `color` | cor | branco | Cor da luz. |
| `target` | `[x,y,z]` | `null` | Cria um empty e aponta a luz via Track To. |
| `rotation` | `[x,y,z]` graus | `null` | Alternativa a `target`; não use os dois. |
| `spotSize` | 1–180° | `45` | Abertura do spot. |
| `spotBlend` | 0–1 | `0.15` | Suavidade da borda do spot. |
| `angle` | 0–180° | `0.526` | Diâmetro angular do sol. |

## Câmera, mundo, render e saída

### `camera`

| Campo | Tipo | Default |
| --- | --- | --- |
| `location` | `[x,y,z]` | `[4.5, -4.5, 2.8]` |
| `target` | `[x,y,z]` | `[0, 0, 0.9]` |
| `rotation` | `[x,y,z]` graus | `null` (alternativa a `target`) |
| `lens` | 8–300 mm | `50` |
| `sensorWidth` | 1–100 mm | `36` |
| `fstop` | 0.7–64 | `4` |
| `focus` | `"target"` \| `"none"` | `"target"` |
| `focusDistance` | 0.001–1000 m | `null` |
| `motionBlur` | boolean | `false` |

DOF fica sempre ligado com o `fstop` informado; `focus: "target"` usa o empty
do alvo como objeto de foco. Se `focusDistance` for informado, ele vence.

### `world`

```json
{ "color": "#101014", "strength": 0.5, "hdri": "assets/studio.hdr" }
```

`hdri` deve ser caminho local; URLs não são baixadas automaticamente
(`warning` + fallback para a cor). O `build.py` procura o arquivo relativo ao
diretório do spec.

### `colorManagement`

```json
{ "viewTransform": "AgX", "look": "None", "exposure": 0 }
```

`viewTransform` típico: `AgX` (padrão 4.x/5.x), `Filmic`, `Standard`.
`look` varia por versão (`None`, `AgX - Medium High Contrast`, …); um look
inválido gera `warning` e mantém o padrão. `exposure` é EV, de -16 a 16.

### `render`

```json
{ "device": "GPU", "adaptive": true, "denoise": true, "maxBounces": 8 }
```

`device` aceita `GPU` (OptiX/CUDA, com fallback para CPU) ou `CPU`.
`maxBounces` é aplicado a `max_bounces`, `diffuse_bounces`, `glossy_bounces` e
`transmission_bounces` quando a propriedade existir.

### `preview`

```json
{ "maxSize": 640, "samples": 32 }
```

`maxSize` é o maior lado do preview (64–4096); o outro lado é proporcional,
com dimensões pares. Previews são sempre PNG RGB/RGBA de 8 bits, independente
do `output.format`.

### `output`

| Campo | Tipo | Default | Observações |
| --- | --- | --- | --- |
| `format` | `PNG` \| `JPEG` \| `EXR` | `PNG` | Vale só para o render final. |
| `transparent` | boolean | `false` | `film_transparent`. |
| `colorDepth` | `"8"` \| `"16"` | `"16"` (PNG) | EXR usa 32 bits. |

O viewer exibe PNG/JPEG; EXR aparece como link para download.

## Comandos incrementais

`POST /jobs/:id/commands` aplica um comando ao spec salvo e dispara um **novo
preview**. Só é aceito quando o job está em `approval/waiting` (ou seja, entre
etapas, com o renderer livre). Cada comando invalida a aprovação anterior:
o usuário precisa aprovar de novo depois de ver o novo preview.

### `add_light`

```json
{
  "op": "add_light",
  "name": "contra",
  "type": "AREA",
  "position": [-2.5, 2, 3],
  "energy": 200,
  "size": 1.2,
  "color": "#bcd6ff",
  "target": [0, 0, 0.8]
}
```

Aceita os mesmos campos de uma luz, exceto `op`. O nome é opcional.

### `set_material`

```json
{ "op": "set_material", "name": "metal", "baseColor": "#8a8f98", "roughness": 0.45 }
```

`name` (ou o alias `material`) identifica um material existente. Os campos
informados são mesclados sobre o material atual; `emission` é mesclado campo a
campo; `textures` substitui a lista inteira. Material inexistente → 400.

### `move_camera`

```json
{ "op": "move_camera", "location": [3, 3, 2.4], "target": [0, 0, 0.8] }
```

Mescla os campos de câmera informados. É o suficiente para aproximar, reposicionar
ou trocar a lente sem reenviar a cena inteira.

### Resposta

```json
{ "id": "ab6e00da272b9f46", "op": "add_light", "state": "running", "stage": "build" }
```

O preview novo chega por SSE e em `GET /state` como `previews[n]`.

## Limites e erros

| Limite | Valor |
| --- | --- |
| Corpo HTTP | 1 MiB |
| Objetos | 200 |
| Materiais | 64 |
| Luzes | 32 |
| Vértices por malha / total customizado | 200.000 |
| Faces por malha | 200.000 |
| Texturas por material | 8 |
| Modificadores por objeto | 16 |
| Resolução | 64–8192 por eixo, ≤50 MP |
| Preview `maxSize` | 64–4096 |
| Samples | 1–100.000 |

Erros:

| HTTP | Quando | Corpo |
| --- | --- | --- |
| 400 | spec/comando inválido | `{"error":"spec inválida","details":["objects[0]: ..."]}` |
| 403 | `Origin` não é local | `{"error":"origem não permitida ..."}` |
| 404 | job/arquivo/rota inexistente | `{"error":"..."}` |
| 409 | comando/aprovação no estado errado | `{"error":"job está em ..."}` |
| 413 | corpo acima de 1 MiB | `{"error":"..."}` |

A validação falha no primeiro problema encontrado e devolve a mensagem em
português, com o caminho do campo (`objects[2].modifiers[0].target`).

## Manifesto

Cada job grava `manifest.json` no diretório de execução. O preview grava/atualiza
o manifesto; o render final mantém a lista de previews e acrescenta `final`.

```json
{
  "schemaVersion": 1,
  "generator": "blender-director/build.py",
  "blenderVersion": "5.2.3 LTS",
  "specName": "Cena de exemplo",
  "engine": "CYCLES",
  "device": "GPU",
  "devices": ["NVIDIA GeForce RTX 3060"],
  "samples": 128,
  "resolution": [1200, 800],
  "colorManagement": { "viewTransform": "AgX", "look": "None", "exposure": 0 },
  "blendFile": "scene.blend",
  "createdAt": "2026-11-04T12:00:00Z",
  "updatedAt": "2026-11-04T12:02:10Z",
  "previews": [
    {
      "stage": "preview",
      "n": 1,
      "file": "preview-001.png",
      "width": 640,
      "height": 426,
      "samples": 32,
      "seconds": 1.8,
      "engine": "CYCLES",
      "device": "GPU",
      "renderedAt": "2026-11-04T12:00:05Z"
    }
  ],
  "lastPreview": { "stage": "preview", "n": 1, "file": "preview-001.png" },
  "final": {
    "stage": "final",
    "file": "final-001.png",
    "width": 1200,
    "height": 800,
    "samples": 128,
    "seconds": 42.6,
    "engine": "CYCLES",
    "device": "GPU",
    "renderedAt": "2026-11-04T12:02:10Z"
  }
}
```

O modo fixture grava `generator: "blender-director/fake-blender.js"`,
`blenderVersion: "fake-5.2.3"` e `device: "CPU (fixture)"`. O manifesto é
exposto em `GET /jobs/:id/manifest`.

Métricas de tempo são medidas no `build.py` em volta de `bpy.ops.render.render`
e não incluem a construção da cena. Use-as como ordem de grandeza; o tempo
varia com GPU, driver, resolução, samples, bounces e complexidade.

## Versão e compatibilidade

- A versão vigente é `schemaVersion: 1`. Campos novos exigem bump de versão ou
  são opcionais com default documentado; o validador rejeita versões diferentes.
- `engine` é o nome lógico do schema; o `build.py` traduz para o enum do
  Blender e tem fallback `BLENDER_EEVEE_NEXT` → `BLENDER_EEVEE`.
- O contrato de eventos do renderer não é o schema do job. Eventos são JSON
  Lines internos (`step`, `preview`, `metric`, `final`, `warning`, `error`,
  `done`) e podem ganhar campos sem quebrar o servidor; o servidor ignora
  eventos desconhecidos com log.
- O `build.py` foi escrito contra a API do Blender 4.x/5.x, mas **não foi
  executado no Blender real neste repositório** (não há Blender no CI). Os
  caminhos que dependem de API menos estável — Geometry Nodes, OptiX, look de
  color management — têm fallback/warning e devem ser validados na máquina
  Windows com Blender 5.2.3 LTS.
