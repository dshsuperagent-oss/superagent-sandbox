# Plano de piso e mobiliario

## Titulo
Mapear pixels de chao/parede para o mundo e medir moveis com mascaras.

## Contexto
Com a camera metrica conhecida, cada pixel pode ser levado ao piso (`z=0`) ou a
uma parede (`x=const`). Isso permite medir/posicionar tapete, mesa e sofa sem
otimizacao 3D pesada.

## Regra/tecnica
- Piso: raio `dir` (mundo), camera `C`; `t = -Cz/dz`; ponto `C+t*dir`.
- Parede direita: `t = (x_parede - Cx)/dx`.
- Tapete: a borda esquerda (x constante) e a borda do fundo (y constante) sao
  as mais confiaveis; use a mediana dos pontos mapeados. O centro costuma
  coincidir com a mesa; com `x_min` e `y_max` visiveis, `lx = 2*(tx-x_min)` e
  `ly = 2*(y_max-ty)`, com clamp para dentro da sala.
- Mesa: mapeie a mascara da tampa no plano `z=0,44` (altura tipica) e pegue
  percentis 1-99 de x/y. A altura e uma priori; a tampa e horizontal.
- Sofa: projete a mascara na parede direita; o intervalo de `y` da o
  comprimento, o percentil 97 de `z` da a altura do encosto. Profundidade,
  assento e bracos sao priors (0,95 / 0,42 / 0,20 m).
- Valide sempre "dentro da sala": `|x| <= L/2`, `|y| <= P/2`, `z>=0`.

## Evidencia
- `ref-A1.png`: tapete com borda esquerda `x=-1,45` e borda do fundo
  `y=1,49`; mesa 1,09 x 0,57 m em (-0,32, 0,10, 0,44); sofa: o encosto
  projetado na parede da comprimento visivel 1,80 m; somar 0,62 m do braco
  dianteiro (que oculta o inicio do encosto) leva a 2,42 m e centro y=0,49.
  Sem essa correcao a similaridade A1 ficava em 0,847; com ela, 0,913.
- Erro comum: usar a media/percentil errado da borda produziu tapete com
  `x_min=-1,28` (15 cm para dentro) e cena 0,7 ponto pior; corrigir para a
  linha mais a esquerda por linha subiu a similaridade de 0,840 para 0,847.
- Um tapete "centrado na mesa" nunca deve sair da sala: o primeiro ajuste
  ingenuo colocou `x_min=-2,69` (fora de L/2=2,04) e reprovaria plausibilidade.

## Quando reutilizar
- Posicionar moveis em plantas 3D a partir de fotos.
- Medir ambientes para orcamento de pintura/piso.
- Qualquer cena com objetos apoiados no chao e camera calibrada.
