# Receita: sala de estar medida a partir de uma referência

Passo a passo para um executor local montar a sala da v3 no Blender, validar
a geometria **antes** do render e avaliar o resultado contra a foto. Os números
abaixo são os de [`examples/room-living.json`](../tools/blender-director/examples/room-living.json);
a foto usada é [`reference/living-room.png`](../tools/blender-director/reference/living-room.png)
(CC BY 2.0, créditos em [`reference/README.md`](../tools/blender-director/reference/README.md)).

> Regra do pipeline: **nenhum render sem `validate.py` exit 0**. O custo do erro
> tem que cair antes do render, não depois. Se o portão reprovar, não renderize.

## 0. O que você precisa

- Blender 5.2.x LTS headless (`blender -b`), CPU ou GPU.
- Python 3 (o mesmo do sistema; o `evaluate.py`/`validate.py` não usam bpy).
- Node 22 (para `assets.js` e para os testes).
- Rede **só na preparação** para baixar assets CC0 do Poly Haven; o render
  roda offline.

```bash
cd tools/blender-director
node assets.js fetch            # baixa .gltf + texturas + HDRIs para assets/
node assets.js validate --require-files
```

## 1. Medir a referência antes de modelar

Meça na foto (1280×854), em coordenadas normalizadas (origem no canto superior
esquerdo):

| Medida | Como medir | Valor no exemplo |
| --- | --- | --- |
| Janela (janela/porta de sacada) | segmentar a região mais clara; pegar o retângulo do vidro | `[0.367, 0.234, 0.196, 0.522]` |
| Horizonte | linha horizontal do centro da janela; câmera nivelada | `y ≈ 0.50` |
| Altura da câmera | o horizonte cruza a janela no centro → câmera na altura do centro da janela | **1,15 m** |
| Sofá | região de cor caramelo à esquerda | `[0.0, 0.35, 0.35, 0.65]` |
| Mesa | região escura no primeiro plano | `[0.36, 0.63, 0.39, 0.37]` |
| Inventário | listar o que existe na foto | sofá, mesa, rack, TV, painel, prateleiras, planta, cortinas, sanca |
| Inteiramente visível | o que não é cortado pela borda | janela, mesa, planta |

Com a janela real de **1,30 × 2,20 m** e a câmera a **4,3 m** dela, a lente que
reproduz o retângulo medido é **24 mm** (sensor 36 mm):

```text
largura projetada  = 1,30 / (2 · 4,3 · tan(hfov/2)) = 0,196  ✓
altura projetada   = 2,20 / (2 · 4,3 · tan(vfov/2)) = 0,522  ✓
```

O `validate.py` confere isso: `reference.measurements.windowRect` contra a
projeção do AABB da abertura; tolerância IoU ≥ 0,70 e centro ≤ 0,05. No
exemplo: **IoU 0,894 / centro 0,009**.

**Resolva câmera e escala primeiro.** Só depois posicione móveis, projetando
as medidas da foto no plano do piso. A câmera não deve ser “ajustada no olho”
depois; se a janela não bate, o resto não bate.

## 2. Dimensionar a sala

| Elemento | Valor | Observação |
| --- | --- | --- |
| Largura interna | 3,60 m | parede a parede (X) |
| Profundidade | 4,80 m | parede a parede (Y) |
| Altura | 2,75 m | piso a teto |
| Espessura das paredes | 0,12 m | fecha as quinas |
| Piso | laje 0,10 m abaixo de z=0 | carpete |
| Teto | laje 0,10 m acima de 2,75 | gesso |
| Janela | 1,30 × 2,20 m, peitoril 0,05, centrada | parede norte, `u = 1,15` |
| Sacada | 1,20 m de profundidade, guarda-corpo 1,05 m, 13 barras | fora da parede norte |
| Fachada | plano a 7,0 m, 18 × 4,5 m | conteúdo visto pela janela |
| Cerca viva | 3,4 × 1,15 × 0,8 m a 0,5 m da sacada | vegetação |

O interior é centrado na origem: `x ∈ [-1,8, 1,8]`, `y ∈ [-2,4, 2,4]`,
`z ∈ [0, 2,75]`. A câmera fica em `[0,2, 1,9, 1,15]` (0,5 m da parede sul),
apontando para `[0, -0,5, 1,15]`: **1,15 m de altura**, sem inclinação.

## 3. Ordem de passes

### Passe 0 — graybox

1. Crie as 4 paredes como caixas (norte/sul com largura + 2×espessura).
2. Recorte a janela com um cutter que atravessa a parede e aplique
   **Boolean EXACT (DIFFERENCE)**. Aplique o modificador e remova o cutter.
3. Crie piso e teto como lajes.
4. Coloque os blocos de mobiliário com `position` = centro da face inferior.
5. Rode o portão: ele reprova interseção entre conjuntos, peça flutuando,
   peça fora da sala, câmera perto demais, janela fora das medidas, objeto de
   teto fora do inventário.

```bash
python3 build_room.py --room examples/room-living.json --out runs/sala \
  --dry-run --resolved runs/sala/resolved-room.json
python3 validate.py --resolved runs/sala/resolved-room.json
```

Só siga quando `validate.py` sair 0. O `build_room.py` sem `--dry-run` roda
esse portão automaticamente antes de renderizar.

### Passe 1 — esquadria, vidro e exterior

- Perfis de 6 cm, um montante central e uma travessa a 35 cm do topo.
- Vidro: `transmission=1`, `roughness=0.03`, `ior=1.5`.
- O preenchimento de céu fica **0,35 m dentro** da janela e **não aparece na
  câmera**; assim o vidro mostra a fachada/cerca viva em vez de um retângulo
  branco.
- A sacada e a cerca viva dão profundidade; a fachada procedural (checker de
  janelas) é um backdrop, não modelagem do prédio.

### Passe 2 — materiais PBR

| Superfície | Material | Base | Roughness | Relevo |
| --- | --- | --- | --- | --- |
| Parede | `parede` | `#b8b0a4` | 0,90 | bump noise 0,04 / 60 |
| Teto | `teto` | `#d0c8bc` | 0,95 | — |
| Carpete | `carpete` | `#5a5854` | 0,96 | noise 180 + bump 0,30 |
| Sofá | `sofa` | `#5f330e` | 0,82 | noise 90 + sheen 0,5 |
| Almofada | `sofa-almofada` | `#6e3d14` | 0,86 | sheen 0,6 |
| Cortina | `cortina` | `#2f332e` | 0,94 | bump 0,05 / 80 |
| Madeira escura | `madeira-escura` | `#241a12` | 0,38 | coat 0,2 |
| Madeira média | `madeira-media` | `#6b5238` | 0,52 | wave/noise |
| Esquadria | `esquadria` | `#2b2c2e` | 0,38 | metallic 0,65 |
| Vidro | `vidro` | branco | 0,03 | transmission 1, ior 1,5 |
| TV | `preto-tv` | `#050506` | 0,28 | metallic 0,25 |
| Fachada | `predio` | `#d8dde3` | 0,95 | checker de janelas |
| Vegetação | `vegetacao` | `#3a5428` | 0,90 | noise + bump |

Regra de ouro: escala real + PBR correto + uma fonte dominante (janela) e
pouca luz ambiente. Se tudo estiver uniformemente claro, o resultado parece
“render de demo”.

### Passe 3 — light rig

Presets em [`light-rig-presets.json`](../tools/blender-director/light-rig-presets.json):

| Preset | Sol | HDRI | Preenchimento | Luminárias | Exposição |
| --- | --- | --- | --- | --- | --- |
| `day` | 4,5 W/m², 35°, ângulo 0,6° | `sky_day`, força 1,0 | 1200 W (override 260 W) | 0,15× 18 W | 0,0 |
| `dusk` | 1,1 W/m², 8°, quente | `sky_dusk`, força 0,55 | 350 W | 0,85× 18 W | +0,4 |
| `night` | desligado | cor `#070b14`, força 0,02 | desligado | 1,0× 18 W | +0,6 |

A exposição efetiva soma `render.colorManagement.exposure` +
`lighting.overrides.exposure` + preset. No exemplo, `-0,75 EV` no color
management para casar a luminância global da foto (~99).

Luminária interna do exemplo: `AREA` de 0,55 m no teto, **18 W**,
`#ffd7a8`. O multiplicador do preset decide se ela está quase apagada (dia)
ou acesa (noite).

### Passe 4 — detalhe

- Ripas verticais no painel de madeira (14 ripas, detalhe isento de colisão).
- Rodapés (detalhe).
- Livros, vaso e xícaras (apoiados em móveis, com `support: furniture`).
- Quadro **na prateleira** (asset `fancy_picture_frame_01`), não solto na
  parede.
- Planta `potted_plant_01` ao lado da janela, `fitHeight=1,25`, fora da
  projeção do rack.

## 4. Câmera e render

| Parâmetro | Valor |
| --- | --- |
| Lente | 24 mm (sensor 36 mm) |
| Altura | 1,15 m |
| Distância à janela | 4,3 m |
| f-stop | f/8 (interior inteiro em foco) |
| Resolução | 1280 × 854 (mesma proporção da foto) |
| Samples | 128 final / 64 preview |
| Engine | Cycles, denoise (OpenImageDenoise), `maxBounces=12` |
| Color management | AgX, look Medium High Contrast, exposição `-0,75` no exemplo |
| Área | 2 400 × 640 preview; final 1280 × 854 |

O `build_room.py` tenta GPU (OptiX/CUDA/HIP/OneAPI/Metal) e cai para CPU com
aviso. O `room-manifest.json` registra `device` e `devices`; não confie em
tempos de GPU sem medir na máquina.

## 5. Aceite por região

O `evaluate.py` compara render × referência em `maxEvalSize=512` e falha se
uma métrica disponível ficar abaixo do limiar. Para este par:

| Região | Retângulo | O que deve bater |
| --- | --- | --- |
| Janela / sacada | `[0.33, 0.12, 0.34, 0.55]` | proporção, cortinas escuras, fundo claro, guarda-corpo |
| Sofá | `[0.0, 0.40, 0.32, 0.56]` | extensão aparente, caramelo escuro, almofadas |
| Painel de mídia | `[0.68, 0.22, 0.32, 0.62]` | TV escura, madeira, prateleiras |
| Piso / carpete | `[0.26, 0.72, 0.48, 0.28]` | tom cinza médio, textura |
| Teto / sanca | `[0.15, 0.0, 0.7, 0.14]` | sanca, sombra, tom quente |

Limiares: `ssimMin 0.5`, `deltaE00Max 20`, `deltaE00RegionMax 30`,
`histogramMax 0.3`, `iouMin 0.6` (IoU só quando há máscaras).

> **Honestidade sobre a métrica:** SSIM e ΔE00 comparam pixels; uma cena
> reconstruída não é a foto. SSIM baixo pode significar textura/objeto
> diferente, não necessariamente erro de geometria. Use o `validate.py` para
> geometria e o `report.json` para cor/luz; não “conserte” a cena para subir
> um número isolado.

## 6. Iterar a partir do relatório

1. Rode `evaluate.py`; abra `comparison.png` (referência | render | diferença).
2. Olhe `report.json`, `regions[]`: ΔE00 alto numa região indica cor/luz; SSIM
   baixo com ΔE00 baixo indica estrutura/textura.
3. Mude **uma** coisa por vez: exposição global, depois potência da janela,
   depois albedo do material da região. Re-renderize no mesmo enquadramento.
4. Rode o portão de novo antes de cada render: `validate.py` exit 0.
5. Só entregue com `validation.json` e `report.json` juntos.

## 7. Comandos completos

```bash
# 1. assets (uma vez)
cd tools/blender-director
node assets.js fetch
node assets.js validate --require-files
cd ..

# 2. plano resolvido + portão
python3 build_room.py --room examples/room-living.json --out runs/sala \
  --dry-run --resolved runs/sala/resolved-room.json
python3 validate.py --resolved runs/sala/resolved-room.json --out runs/sala/validation.json

# 3. render final (roda o portão antes)
blender -b --python-exit-code 1 -P build_room.py -- \
  --room examples/room-living.json --out runs/sala --stage final --progress-json

# 4. avaliação
python3 evaluate.py --render runs/sala/final-001.png \
  --room examples/room-living.json --out runs/sala

# 5. testes (sem Blender/rede)
node test/room-e2e.js
```

## 8. O que este exemplo **não** prova

- Não é uma reconstrução fotorrealista da foto: é um graybox medido, com
  materiais/asset/luz plausíveis e um portão geométrico.
- A fachada externa é um plano com textura, não um prédio modelado.
- O `validate.py` usa AABB: peças curvas são aproximadas pela caixa.
- SSIM/ΔE00 não provam fotorrealismo absoluto; são piso de regressão contra
  este par.
- Não há máscara de referência para IoU no exemplo; a métrica fica
  indisponível e o relatório diz isso, em vez de inventar um valor.
