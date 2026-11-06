# Checklist de fidelidade — sala v3 (render final)

Render: `docs/img/v3-sala-render.png` (1280×854, Cycles CPU, 128 spp,
OpenImageDenoise, 59,9 s). Referência: `tools/blender-director/reference/living-room.png`
(CC BY 2.0). Relatório bruto: `docs/v3-avaliacao.json`; portão:
`docs/v3-validacao-depois.json`; manifesto: `docs/v3-manifest.json`.

## Portão determinístico (antes do render)

| Regra | Resultado | Evidência |
| --- | --- | --- |
| Interseção AABB entre conjuntos | **passa** | 62 peças, 0 erro |
| Apoio (piso/topo) e nada enterrado | **passa** | 0 erro |
| Contenção no volume interno | **passa** | 0 erro |
| Câmera a ≥ 1,0 m de sólido | **passa** | câmera em `[0,2, 1,9, 1,15]` |
| Enquadramento (`fullyVisible`) | **passa** | mesa, planta e janela inteiras |
| Inventário acima de 2,6 m | **passa** | quadro na prateleira está no inventário |
| Layout medido da foto | **passa** | janela IoU **0,894**, centro **0,009**; câmera **1,15 m** |
| Assets (baixado, bbox, eixo/volume) | **passa** | 2 assets CC0 importados |
| **Exit code** | **0 (VÁLIDO)** | `docs/v3-validacao-depois.json` |

O portão **bloqueou** duas versões do plano durante a iteração:

- uma com `planta-janela` dentro do `rack-base` e o eixo do quadro dentro da
  prateleira (exit 2; ver `docs/v3-validacao-antes.json`);
- uma com a cortina `d-3` penetrando a planta em 2,2 cm e o quadro apoiado
  dentro da prateleira (exit 2).

## Render × referência (`evaluate.py`)

| Métrica | Limiar | Medido | Situação |
| --- | --- | --- | --- |
| SSIM | ≥ 0,50 | **0,2308** | **reprova** |
| ΔE00 médio | ≤ 20 | **25,99** | **reprova** |
| ΔE00 máximo por região | ≤ 30 | **32,42** (mídia) | **reprova** |
| Distância de histograma | ≤ 0,30 | **0,2675** | passa |
| IoU de silhueta | ≥ 0,60 | indisponível (sem máscara de referência) | não avaliado |

### Por região

| Região | ΔE00 | SSIM | Leitura |
| --- | --- | --- | --- |
| Janela / sacada | 25,54 | 0,172 | geometria/proporção corretas (IoU 0,894); cor e contraste do exterior ainda diferem |
| Sofá | 17,75 | 0,229 | cor/posição próximas; textura e almofadas simplificadas |
| Painel de mídia | **32,42** | 0,118 | TV/ripas/madeira mais claros e regulares que a foto |
| Piso / carpete | 25,63 | 0,077 | carpete plano/limpo; a foto tem textura e sombras |
| Teto / sanca | 22,75 | 0,483 | melhor região; sanca e gradiente de luz próximos |

## Conclusão honesta

- **Geometria, escala, câmera, enquadramento, suporte e assets: validados pelo
  portão** (exit 0). O pipeline faz o que o pedido de método exige: reprova
  antes do render.
- **Fidelidade de imagem: não passa** em SSIM (0,23 < 0,50) e ΔE00
  (25,99 > 20; região da mídia 32,42 > 30). O histograma passa (0,2675 < 0,30).
- O render é uma reconstrução medida simplificada, não uma cópia da foto:
  texturas, almofadas, objetos de decoração e a fachada externa são
  aproximações. SSIM compara pixels; uma cena modelada com outro carpete,
  cortina e TV não atinge 0,5 sem reproduzir a foto (photo projection), o que
  seria "render fake".

Sem ajuste de limiar ou autorização para uma reconstrução de fidelidade
fotográfica, este item de aceite **não está cumprido**.
