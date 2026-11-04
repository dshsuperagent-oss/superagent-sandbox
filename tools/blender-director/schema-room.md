# Room plan v1 — contrato da sala (Blender Director v3)

O **room plan** é o documento de entrada da v3: uma sala medida em metros,
com paredes, piso, teto, **aberturas recortadas por boolean**, mobiliário em
blocos, **assets livres importados**, um **light rig** com presets, câmera,
render e o bloco de avaliação contra a referência.

```text
room-living.json ──► build_room.py ──► resolved-room.json
                          │                    │
                          │                    ├── validate.py   (portão)
                          ├── Blender          │
                          │   ├── paredes + boolean
                          │   ├── assets (.glTF/.blend)
                          │   ├── light rig
                          │   └── render PNG ──► evaluate.py (SSIM/ΔE00/IoU)
                          │                          └── comparison.png + report.json
                          └── room-manifest.json (licenças, watts, device, tempos)
```

- Validação: [`lib/room.js`](lib/room.js) (Node, schema) e
  [`build_room.py`](build_room.py) (Python, dentro/fora do Blender).
- Construção: [`build_room.py`](build_room.py).
- Portão determinístico: [`validate.py`](validate.py).
- Avaliação: [`evaluate.py`](evaluate.py).
- Exemplo: [`examples/room-living.json`](examples/room-living.json).

O contrato é **fechado**: campos desconhecidos são rejeitados para pegar erros
de digitação cedo. A versão vigente é `schemaVersion: 1`.

## Sumário

1. [Convenções](#convenções)
2. [Documento completo](#documento-completo)
3. [Campos de topo](#campos-de-topo)
4. [Sala, paredes e aberturas](#sala-paredes-e-aberturas)
5. [Materiais PBR](#materiais-pbr)
6. [Mobiliário em blocos](#mobiliário-em-blocos)
7. [Assets importados](#assets-importados)
8. [Light rig](#light-rig)
9. [Câmera, render e saída](#câmera-render-e-saída)
10. [Referência medida](#referência-medida)
11. [Avaliação](#avaliação)
12. [Plano resolvido](#plano-resolvido)
13. [Portão de validação](#portão-de-validação)
14. [CLI](#cli)
15. [Manifesto do job](#manifesto-do-job)
16. [Limites, erros e compatibilidade](#limites-erros-e-compatibilidade)

## Convenções

| Dado | Formato | Observação |
| --- | --- | --- |
| Comprimento | metros | Escala real é pré-requisito de fotorrealismo. |
| Rotação | graus | Convertida para radianos no `build_room.py`. |
| Cor | `"#rrggbb"` (sRGB) ou `[r,g,b]` linear | Hex é convertido para linear; arrays já são lineares. |
| Posição de móvel | `[x,y,z]` = **centro da face inferior** | `z` é a base; o `build_room.py` calcula o centro do AABB. |
| AABB | `{min:[x,y,z], max:[x,y,z]}` | Usado pelo `validate.py`. |
| Câmera | `location`, `target`, `lens` (mm), `sensorWidth`, `fstop` | `target` cria um Track To; `rotation` é a alternativa. |
| Energia | watts (AREA/POINT/SPOT) e W/m² (SUN) | A mesma convenção do schema v1. |
| Exposição | EV | `render.colorManagement.exposure` + `lighting.overrides*` = exposição efetiva. |

O interior da sala é centrado na origem: piso em `z = 0`, teto em
`z = room.interior.height`, faces internas em `x = ±width/2` e
`y = ±depth/2`. A parede `north` fica em `y = -depth/2`.

## Documento completo

Exemplo reduzido (o completo está em
[`examples/room-living.json`](examples/room-living.json)):

```json
{
  "schemaVersion": 1,
  "name": "Sala de estar — apartamento com janela central",
  "description": "Sala medida a partir da foto de referência.",
  "room": {
    "interior": { "width": 3.6, "depth": 4.8, "height": 2.75 },
    "wallThickness": 0.12,
    "floor": { "material": "carpete", "thickness": 0.1 },
    "ceiling": { "material": "teto", "thickness": 0.1 },
    "openings": {
      "frame": { "profile": 0.06, "depth": 0.1, "mullions": 1, "transom": 0.35 },
      "frameMaterial": "esquadria",
      "glassMaterial": "vidro",
      "glass": true
    },
    "walls": [
      { "side": "north", "material": "parede", "openings": [
        { "id": "janela-sala", "type": "window", "u": 1.15, "bottom": 0.05,
          "width": 1.3, "height": 2.2, "frame": { "mullions": 1, "transom": 0.35 }, "glass": true }
      ] },
      { "side": "south", "material": "parede", "openings": [] },
      { "side": "east", "material": "parede", "openings": [] },
      { "side": "west", "material": "parede", "openings": [] }
    ]
  },
  "exterior": {
    "balcony": { "enabled": true, "depth": 1.2, "railingHeight": 1.05, "bars": 13, "material": "metal" },
    "backdrop": {
      "enabled": true,
      "facade": { "material": "predio", "distance": 7.0, "width": 18, "height": 4.5 },
      "hedge": { "material": "vegetacao", "width": 3.4, "height": 1.15, "depth": 0.8, "offset": 0.5 }
    }
  },
  "materials": { "parede": { "baseColor": "#c9c1b4", "roughness": 0.9 } },
  "furniture": [
    { "id": "sofa-base", "shape": "roundbox", "size": [0.9, 2.2, 0.35],
      "position": [1.42, -0.3, 0.12], "material": "sofa", "bevel": 0.05,
      "support": "floor", "collisionGroup": "sofa" }
  ],
  "assets": [
    { "id": "planta-janela", "assetId": "potted_plant_01", "position": [-1.5, -2.0, 0.0],
      "rotation": [0, 0, 0], "fitHeight": 1.25, "anchor": "bottom", "snapToFloor": true,
      "support": "floor" }
  ],
  "lighting": {
    "preset": "day",
    "hdri": { "day": "sky_day", "dusk": "sky_dusk" },
    "environmentRotation": 200,
    "overrides": { "sun": { "azimuth": 15, "elevation": 28 }, "world": { "strength": 0.5 }, "windowFill": { "energy": 260, "color": "#ffe2c4" } },
    "overridesByPreset": { "day": { "windowFill": { "energy": 260 } } },
    "interiorFixtures": [
      { "id": "teto", "type": "AREA", "position": [0.0, -0.2, 2.64], "size": 0.55,
        "watts": 18, "color": "#ffd7a8", "target": [0.0, -0.2, 0.0] }
    ]
  },
  "camera": { "location": [0.2, 1.9, 1.15], "target": [0.0, -0.5, 1.15], "lens": 24,
              "sensorWidth": 36, "fstop": 8 },
  "render": {
    "engine": "CYCLES", "samples": 128, "resolution": [1280, 854],
    "preview": { "maxSize": 640, "samples": 64 },
    "render": { "device": "GPU", "denoise": true, "maxBounces": 12 },
    "colorManagement": { "viewTransform": "AgX", "look": "AgX - Medium High Contrast", "exposure": -0.75 },
    "output": { "format": "PNG", "transparent": false, "colorDepth": "8" }
  },
  "evaluation": { "reference": "../reference/living-room.png", "regions": [], "thresholds": {} },
  "reference": { "measurements": { "windowRect": [0.367, 0.234, 0.196, 0.522],
                  "horizonY": 0.5, "cameraHeight": 1.15 },
                 "inventory": ["sanca-janela", "janela-sala"], "fullyVisible": ["janela-sala"] }
}
```

## Campos de topo

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `schemaVersion` | `1` | sim | Outra versão é rejeitada. |
| `name` | string ≤120 | não | Nome do job. |
| `description` | string ≤2000 | não | Contexto e origem das medidas. |
| `room` | objeto | sim | Dimensões, paredes, piso, teto, aberturas. |
| `exterior` | objeto | não | Sacada, fachada e cerca viva vistos pela janela. |
| `materials` | objeto | sim | Materiais PBR por nome. |
| `furniture` | array | não | Blocos de mobiliário. |
| `assets` | array | não | Colocações de assets da biblioteca. |
| `lighting` | objeto | não | Preset, sol, céu, luminárias internas. |
| `camera` | objeto | não | Câmera; defaults do schema v1. |
| `render` | objeto | não | Engine, samples, resolução, color management. |
| `evaluation` | objeto | não | Referência, regiões e limiares. |
| `reference` | objeto | não | Medidas feitas na foto + inventário/enquadramento. |

## Sala, paredes e aberturas

### `room`

| Campo | Tipo | Default | Descrição |
| --- | --- | --- | --- |
| `interior.width` | 1.5–15 m | — | Largura interna (eixo X). |
| `interior.depth` | 1.5–15 m | — | Profundidade interna (eixo Y). |
| `interior.height` | 2–6 m | — | Altura do piso ao teto. |
| `wallThickness` | 0.05–0.5 m | `0.12` | Espessura das 4 paredes. |
| `floor.material` | nome | — | Material do piso. |
| `floor.thickness` | 0.01–0.5 m | `0.1` | Laje abaixo de `z=0`. |
| `ceiling.material` | nome | — | Material do teto. |
| `ceiling.thickness` | 0.01–0.5 m | `0.1` | Laje acima de `z=height`. |
| `walls` | 4 itens | — | Exatamente `north`, `south`, `east`, `west`. |
| `openings` | objeto | `{}` | Estilo padrão das esquadrias/vidro. |

As paredes norte/sul são construídas com o comprimento interno + 2× espessura
(para fechar as quinas); leste/oeste ocupam a profundidade interna. O piso e o
teto são lajes independentes. Todas as peças são caixas com UV de cubo.

### `room.walls[]`

| Campo | Tipo | Descrição |
| --- | --- | --- |
| `side` | `north`\|`south`\|`east`\|`west` | Único por parede. |
| `material` | nome | Material da parede. |
| `openings` | array | Até 8 por parede (16 no total). |

### `room.openings` (estilo)

| Campo | Tipo | Default | Descrição |
| --- | --- | --- | --- |
| `frame.profile` | 0.005–0.3 m | `0.05` | Largura dos perfis. |
| `frame.depth` | 0.005–0.6 m | `0.07` | Profundidade (limitada à espessura da parede). |
| `frame.mullions` | 0–6 | `0` | Montantes internos. |
| `frame.transom` | 0–3 m | `0` | Travessa horizontal a partir do topo. |
| `frameMaterial` | nome | — | Material da esquadria. |
| `glassMaterial` | nome | — | Material do vidro. |
| `glass` | boolean | `true` | Vidro padrão para janelas. |

### `room.walls[].openings[]`

| Campo | Tipo | Default | Descrição |
| --- | --- | --- | --- |
| `id` | string | gerado | Nome do objeto/abertura. |
| `type` | `window`\|`door` | `window` | Porta começa no piso. |
| `u` | 0..comprimento−largura | — | Borda esquerda, a partir do início da parede. |
| `bottom` | 0..altura−0.3 | `0.9` (janela) / `0` (porta) | Peitoril. |
| `width` | 0.3–6 m | — | Largura. |
| `height` | 0.3..altura−0.02 | — | Altura. |
| `frame` | objeto | estilo | Sobrescreve o estilo. |
| `glass` | boolean | `true` (janela) | Vidro; janela exige vidro nesta versão. |
| `leaf` | boolean | `false` | Folha opaca de porta. |

Para `north`/`south`, `u` corre ao longo de +X a partir de `x=-width/2`;
para `east`/`west`, ao longo de +Y a partir de `y=-depth/2`.

O `build_room.py` recorta a abertura com um **cutter** que atravessa a parede
inteira e aplica um modificador **Boolean EXACT (DIFFERENCE)**. Em seguida
aplica o modificador e remove o cutter. A esquadria e o vidro são gerados no
plano médio da parede; o vidro tem `transmission=1`, `roughness=0.03`,
`ior=1.5`.

## Materiais PBR

Mapa `nome → material` (até 64). O `build_room.py` cria um Principled BSDF
com os mesmos campos do schema v1:

`baseColor`, `metallic`, `roughness`, `ior`, `transmission`, `subsurface`,
`coat`, `sheen`, `anisotropy`, `emission {color,strength}`, `normal` e
`textures` (a primeira alimenta a Base Color). Tipos de textura: `noise`,
`voronoi`, `wave`, `checker`, `image`; `normal` aceita `bump` ou `image`.

Materiais com `transmission` alta (vidro) são os únicos com transparência;
para janelas use o par `esquadria` + `vidro`.

## Mobiliário em blocos

| Campo | Tipo | Default | Descrição |
| --- | --- | --- | --- |
| `id` | string | `peca-N` | Único; vai para o nome do objeto. |
| `shape` | `box`\|`roundbox`\|`cylinder` | `box` | `roundbox` = cubo + bevel. |
| `size` | `[x,y,z]` 0.01–12 m | — | Dimensões. |
| `position` | `[x,y,z]` | — | Centro da face inferior. |
| `rotation` | `[x,y,z]` graus | `[0,0,0]` | Aplicada após o bevel. |
| `material` | nome | — | Obrigatório. |
| `bevel` | 0–0.25 m | `0.03` (roundbox) | Chanfro. |
| `smooth` | boolean | `true` p/ roundbox | Shading suave. |
| `support` | `floor`\|`furniture`\|`wall`\|`ceiling` | `floor` | Como a peça se apoia (usado pelo portão). |
| `collisionGroup` | string | prefixo do id | Peças do mesmo conjunto não colidem entre si. |
| `detail` | boolean | `false` | Detalhe aplicado (ripa, rodapé): isento de interseção. |

O portão trata como “mesmo conjunto” peças com o mesmo `collisionGroup`.
Sofá, rack e ripas usam grupos explícitos; peças sem grupo herdam o prefixo do
id antes do primeiro `-`.

## Assets importados

O binário **não é versionado**. A biblioteca
[`assets-library.json`](assets-library.json) registra procedência/licença; o
`node assets.js fetch` baixa os arquivos para `assets/` (ignorado pelo git) e
grava `assets/index.json` com o caminho do arquivo principal.

### Biblioteca (`assets-library.json`)

```json
{
  "schemaVersion": 1,
  "assetsDir": "assets",
  "assets": {
    "potted_plant_01": {
      "name": "Potted Plant 01",
      "kind": "model",
      "format": "gltf",
      "provider": "polyhaven",
      "providerId": "potted_plant_01",
      "resolution": "1k",
      "bbox": { "min": [-0.339, -0.270, -0.014], "max": [0.249, 0.364, 1.337] },
      "source": {
        "url": "https://polyhaven.com/a/potted_plant_01",
        "author": "Poly Haven contributors",
        "license": "CC0-1.0",
        "licenseUrl": "https://polyhaven.com/license"
      }
    }
  }
}
```

Licenças aceitas: `CC0-1.0`, `CC-BY-2.0/3.0/4.0`, `CC-BY-SA-3.0/4.0`,
`Public-Domain`. Sem licença reconhecida, o asset não entra.

- `kind: "model"` → `format` `gltf`|`glb`|`blend`.
- `kind: "hdri"` → `format` `hdr`|`exr`.
- `bbox` é o AABB nativo do modelo, em metros; o portão usa para calcular o
  volume do asset já transformado. **Obrigatório para modelos.**

### `room.assets[]`

| Campo | Tipo | Default | Descrição |
| --- | --- | --- | --- |
| `id` | string | `asset-N` | Nome da colocação. |
| `assetId` | string | — | Chave na biblioteca. |
| `position` | `[x,y,z]` | — | Ver `anchor`. |
| `rotation` | `[x,y,z]` graus | zeros | Aplicada ao nó raiz do asset. |
| `scale` | 0.002–50 | `1` | Escala uniforme. |
| `fitHeight` | 0.01–12 m | `null` | Normaliza a altura do asset; vence `scale`. |
| `anchor` | `bottom`\|`origin` | `bottom` | `bottom` alinha o AABB ao piso; `origin` usa a origem do asset. |
| `snapToFloor` | boolean | `true` | Ajusta o AABB ao piso quando `anchor=bottom`. |
| `materialOverride` | nome | `null` | Substitui todos os materiais do asset. |
| `visible` | boolean | `true` | Importa ou não. |
| `support` | `floor`\|`furniture`\|`wall`\|`ceiling` | `floor` | Como o asset se apoia. |

A importação usa `bpy.ops.import_scene.gltf` para glTF/GLB e
`bpy.data.libraries.load` + `bpy.ops.wm.append` para `.blend` (objeto
opcional). O asset é agrupado sob um empty, escalado/rotacionado e, quando
`anchor=bottom`, o AABB é apoiado no ponto pedido. A licença de cada asset
importado vai para `room-manifest.json`.

## Light rig

[`light-rig-presets.json`](light-rig-presets.json) define `day`, `dusk` e
`night`:

| Preset | Sol (W/m²) | HDRI | Preenchimento (W) | Luminárias | Exposição |
| --- | --- | --- | --- | --- | --- |
| `day` | 4.5, 35° | `sky_day`, força 1.0 | 1200 | 0.15× | 0.0 |
| `dusk` | 1.1, 8° | `sky_dusk`, força 0.55 | 350 | 0.85× | +0.4 |
| `night` | desligado | cor `#070b14`, força 0.02 | desligado | 1.0× | +0.6 |

| Campo | Tipo | Descrição |
| --- | --- | --- |
| `preset` | `day`\|`dusk`\|`night` (aceita `dia`, `fim-de-tarde`, `noite`) | Base do rig. |
| `hdri` | string ou `{preset: id}` | Asset HDRI da biblioteca. |
| `environmentRotation` | −360..360° | Gira o HDRI. |
| `overrides` | objeto | Ajustes que valem para **todos** os presets. |
| `overridesByPreset` | `{preset: overrides}` | Ajustes por preset. |
| `interiorFixtures` | array | Luminárias internas (AREA/POINT/SPOT) em watts. |

`overrides` e `overridesByPreset` aceitam `sun {enabled,strength,color,angle,azimuth,elevation}`,
`world {kind,color,strength}`, `windowFill {enabled,energy,size,color}` e
`exposure` (EV). A exposição efetiva é
`preset.exposure` + `overrides.exposure` + `render.colorManagement.exposure`.

- **Sol**: `azimuth` 0° = norte (−Y), 90° = leste (+X); `elevation` acima do
  horizonte. A posição do sol é calculada a 30 m do centro e aponta para a
  sala via Track To.
- **Preenchimento da janela**: área retangular do tamanho da abertura,
  **0,35 m dentro da sala**, apontando para dentro. Ela simula o céu difuso e
  **não é visível à câmera** (`visible_camera=false`, `visible_glossy=false`,
  `visible_transmission=false`), para o vidro mostrar a vista externa em vez
  de um retângulo branco.
- **Luminárias internas**: cada `interiorFixture.watts` é multiplicado pelo
  `interiorMultiplier` do preset; um `POINT`/`AREA` usa watts do Blender, um
  `SPOT` usa `spotSize`/`spotBlend`.

## Câmera, render e saída

`camera` e `render` usam o mesmo contrato do schema v1 (campos, defaults e
faixas). Resumo:

- `camera`: `location`, `target` (ou `rotation`), `lens` 8–300 mm,
  `sensorWidth` 1–100 mm, `fstop` 0.7–64, `focus`/`focusDistance`.
- `render.engine`: `CYCLES` (padrão) ou `BLENDER_EEVEE_NEXT`.
- `render.samples`, `render.resolution`, `render.preview {maxSize,samples}`,
  `render.render {device,adaptive,denoise,maxBounces}`,
  `render.colorManagement {viewTransform,look,exposure}`,
  `render.output {format,transparent,colorDepth}`.
- `render.resolution` deve ter a mesma proporção da foto de referência; o
  `evaluate.py` redimensiona a referência se necessário e registra isso.

## Referência medida

`reference` registra o que foi **medido** na foto antes de posicionar móveis:

| Campo | Tipo | Descrição |
| --- | --- | --- |
| `image` | caminho | Foto (o `evaluate.py` usa `evaluation.reference`). |
| `measurements.windowRect` | `[x,y,w,h]` normalizado | Retângulo medido da janela. |
| `measurements.horizonY` | 0..1 | Linha do horizonte (centro da janela na foto). |
| `measurements.cameraHeight` | metros | Altura deduzida do horizonte. |
| `measurements.sofaRect` | `[x,y,w,h]` | Extensão aparente do sofá. |
| `measurements.tableRect` | `[x,y,w,h]` | Extensão aparente da mesa. |
| `measurements.notes` | string | Como cada medida foi feita. |
| `inventory` | lista de ids | O que existe na foto (regra de peças >2,6 m). |
| `fullyVisible` | lista de ids | Objetos que a foto mostra inteiros. |

No exemplo, a janela medida tem `windowRect = [0.367, 0.234, 0.196, 0.522]`
e o horizonte cai no centro da janela → câmera a **1,15 m**; a janela real
(1,30 × 2,20 m) a 4,3 m com lente **24 mm** projeta IoU **0,894** e erro de
centro **0,009** contra a medida. A câmera é resolvida **antes** dos móveis; os
móveis são posicionados por projeção e conferidos pelo `fullyVisible`.

## Avaliação

```json
"evaluation": {
  "reference": "../reference/living-room.png",
  "referenceMask": null,
  "requireMasks": false,
  "regions": [
    { "id": "janela", "label": "Janela / sacada", "rect": [0.33, 0.12, 0.34, 0.55] }
  ],
  "thresholds": {
    "ssimMin": 0.5,
    "deltaE00Max": 20,
    "deltaE00RegionMax": 30,
    "histogramMax": 0.3,
    "iouMin": 0.6
  },
  "histogramBins": 16,
  "maxEvalSize": 512,
  "notes": "Limiares calibrados para este par; piso de regressão."
}
```

O `evaluate.py` gera `comparison.png` (referência, render, diferença
amplificada e sobreposição de máscaras quando houver) e `report.json`, e
**falha** (exit 2) se uma métrica disponível ficar abaixo do limiar. IoU só é
avaliado quando existem as duas máscaras; `requireMasks: true` transforma a
ausência em reprovação.

## Plano resolvido

`build_room.py --dry-run --resolved resolved.json` escreve o documento
consumido pelo `validate.py`: dimensões, caixas de paredes, **cutter/bbox de
cada abertura**, caixas de móveis com `support/collisionGroup/detail`, assets
com `bbox` no mundo e licença, luzes resolvidas (preset + overrides), câmera,
render, `reference` e a lista `missingAssets`.

O resolvedor também roda fora do Blender (`--dry-run`), então o portão e os
testes não dependem de GPU nem de render.

## Portão de validação

`validate.py --resolved resolved.json` (exit 0 válido, 2 reprovado) aplica:

| Regra | O que reprova |
| --- | --- |
| `intersection` | AABB de peças de conjuntos diferentes com penetração > 2 cm nos três eixos (detalhes `detail` e mesmo `collisionGroup` são isentos). |
| `support` | Peça de piso que não toca o chão nem o topo de outra peça (folga > 2 cm) ou peça `furniture` sem apoio; base enterrada. |
| `containment` | Qualquer AABB fora do volume interno (tolerância 1 cm). |
| `camera-distance` | Lente a menos de 1,0 m de qualquer sólido móvel. |
| `framing` | Objeto de `reference.fullyVisible` com algum dos 8 cantos fora do frustum. |
| `inventory` | Peça acima de 2,6 m cujo id não está em `reference.inventory`. |
| `layout` | Altura da câmera diferente de `reference.measurements.cameraHeight` (> 5 cm) ou janela projetada com IoU < 0,70 / centro > 0,05 contra `windowRect`. |
| `assets` | Asset não baixado/sem bbox, eixo do asset dentro de um móvel, ou volume do asset penetrando móvel > 2 cm. |

O `build_room.py` roda o portão **antes** de qualquer render (salvo
`--skip-validation`, não recomendado) e grava `validation.json` no diretório do
job. O `--dry-run --validate` roda o portão com assets ausentes permitidos.

## CLI

```bash
# 1. baixar assets livres (uma vez; grava assets/index.json)
node tools/blender-director/assets.js fetch

# 2. validar o plano e gravar o resolved
python3 tools/blender-director/build_room.py \
  --room tools/blender-director/examples/room-living.json \
  --out runs/sala --dry-run --resolved runs/sala/resolved-room.json

# 3. portão
python3 tools/blender-director/validate.py --resolved runs/sala/resolved-room.json

# 4. render (roda o portão antes)
blender -b --python-exit-code 1 -P tools/blender-director/build_room.py -- \
  --room tools/blender-director/examples/room-living.json \
  --out runs/sala --stage final --progress-json

# 5. avaliação contra a referência
python3 tools/blender-director/evaluate.py --render runs/sala/final-001.png \
  --room tools/blender-director/examples/room-living.json --out runs/sala
```

`assets.js` tem `list`, `validate [--require-files]`, `plan` e
`fetch [--only id] [--dry-run] [--force]`.

## Manifesto do job

`runs/<job>/room-manifest.json` registra: `blenderVersion`, `planName`,
`summary`, dimensões, preset/exposição/sol/mundo/preenchimento/luminárias,
câmera, engine/samples/resolution/device/devices, **licenças dos assets
importados**, estágios (preview/final com arquivo, dimensões, samples,
segundos) e `missingAssets`.

## Limites, erros e compatibilidade

| Limite | Valor |
| --- | --- |
| Paredes | 4 (retângulo) |
| Aberturas | 8 por parede, 16 no total |
| Móveis | 240 |
| Assets | 64 |
| Luminárias | 24 |
| Materiais | 64 |
| Regiões de avaliação | 16 |
| Resolução | 64–8192 por eixo, ≤50 MP |
| Corpo HTTP | n/a (o build_room não sobe servidor) |

Erros de schema viram `PlanError` (exit 1) com o caminho do campo. Erros de
portão viram exit 2 e um relatório com `rule/ids/detail`.

Compatibilidade: a v3 é **aditiva**. `build.py`, `schema.md`, o servidor e os
testes da v1/v2 não foram alterados. O `build_room.py` reaproveita os helpers
de material/render/câmera/luzes do `build.py`, então mudanças na v1 podem
afetar a v3 — por isso o e2e compara os dois resolvedores.

Limitações conhecidas:

- O room plan é retangular (4 paredes); plantas em L exigem outra versão.
- O portão usa AABB (não malha exata); peças curvas são aproximadas pela caixa.
- A fachada externa é um plano com textura procedural (não é modelagem do
  prédio); a sacada e a cerca viva são geometria.
- O `validate.py` não substitui inspeção visual de cor; ele cobre geometria,
  inventário e enquadramento.
- As métricas de avaliação não provam fotorrealismo absoluto; são um piso de
  regressão contra uma referência específica.
