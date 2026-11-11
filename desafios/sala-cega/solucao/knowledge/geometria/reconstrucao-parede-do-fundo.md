# Reconstrucao da parede do fundo

## Titulo
De frame relativo da janela para dimensoes metricas da sala.

## Contexto
Depois da homografia da janela temos camera e janela num referencial com
origem no canto inferior-esquerdo da janela e eixos do mundo. Falta a sala.

## Regra/tecnica
- A parede do fundo e o plano `y=0` nesse referencial. Para um pixel, o raio
  `K^-1[x,y,1]` vira direcao no mundo via `R^T`; a camera esta em
  `C = -R^T T` (T da homografia). Intersecte `C + t*d` com `y=0`.
- Linha teto-parede -> `Z=Hrel`; linha piso-parede -> `Z=Zfloor`; entao
  `H = Hrel - Zfloor` e peitoril `z0 = -Zfloor` (em larguras de janela).
- A aresta vertical do canto da o `Xright` (parede direita) relativo a janela.
- Escolha a escala: `escala = ALTURA_SALA / H` (priori 2,70 m). Entao
  `L = margem_esq + (Xright - Cx)*escala`, `P = margem_frente + 0,05 - Cy*escala`,
  camera e janela saem em metros.
- Margens tipicas da camera: 0,3-0,6 m das paredes esquerda/frente (a frente
  nao aparece na imagem, entao P nao e observavel; use priori).
- Refine com Nelder-Mead minimizando residuos das retas e dos 4 cantos da
  janela (Huber, limiar ~2,5 px).

## Evidencia
- `ref-A1.png`: Hrel=1,307, Zfloor=-0,343, Xright=2,371 (unidades de largura
  da janela). Com H=2,70 m: L=3,96 m, P=4,39 m, camera (-1,68,-1,90,1,49),
  janela u0=-1,98, u1=-0,29, z0=0,54, z1=2,00.
- A janela reconstruida projeta nos cantos detectados com erro ~0,5 px.
- `P` e o parametro menos observavel (parede da frente invisivel): variar a
  margem frontal em 0,3 m muda pouco a vista A, mas muda a vista B.

## Quando reutilizar
- Reconstrucao de interiores a partir de uma foto (planejamento de reforma,
  VR, gacha de imovel).
- Medir altura de teto/peitoril em fotos com uma janela visivel.
- Sempre declare a priori de escala e o que nao e observavel.
