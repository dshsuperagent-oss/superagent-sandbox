# Pontos de fuga e rotacao da camera

## Titulo
Recuperar rotacao (yaw/pitch) e comprimento focal de tres familias de retas
ortogonais.

## Contexto
Numa sala axis-aligned, as arestas verticais (Z), as linhas do teto/piso (X) e
as arestas da parede lateral (Y) formam tres direcoes ortogonais. Seus pontos
de fuga (VP) determinam a rotacao e a focal.

## Regra/tecnica
- Extraia retas subpixel por varredura de gradiente e ajuste robusto (mediana
  + MAD). Para o VP de uma familia, minimize a soma dos quadrados das
  distancias ponto-reta (normais normalizadas).
- Com `K` (f conhecido), `d_i = normalize(K^-1 vp_i)` sao os eixos do mundo nas
  coordenadas da camera. Escolha sinais fisicos: +X tem componente x positiva,
  +Z (para cima) tem componente y negativa, +Y (para dentro) tem z positiva.
  `R = [ex, ey, ez]` (colunas).
- A focal tambem pode ser estimada por ortogonalidade: `(K^-1 vx).(K^-1 vz)=0`.
  Neste kit a lente e fixa em 24 mm; usar a priori evita amplificar ruido.
- Ordem de confianca das retas: topo da janela (muito forte), aresta vertical
  da janela, linha teto-parede, linha piso-parede (fraca), linha teto-direita.
- Prefira a **intersecao das duas linhas de topo** como canto geometrico; a
  aresta vertical serve para refinar. Se a aresta vertical nao existir (canto
  fora do quadro), use a intersecao.

## Evidencia
- `ref-A1.png`: VPs em (496, 97) [X] e (125, 973) [Z]; yaw 25,3 graus, pitch
  11,4 graus; horizonte em y~96-100 px (com lente 24 mm).
- A linha teto-direita projetada passa a 0,8 px do VP_Y previsto.
- Erro de 1 px no canto da janela desloca o VP_X em dezenas de px: linhas
  quase paralelas sao mal condicionadas. Sempre reporte/limite o efeito.

## Quando reutilizar
- Fotogrametria de interior, AR, correcao de perspectiva.
- Estimar FOV de uma foto a partir de linhas de predio/estrada.
- Detectar horizonte e inclinacao de camera.
