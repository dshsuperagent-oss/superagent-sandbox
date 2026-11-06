# Camera pinhole e projecao

## Titulo
Camera pinhole compativel com o `builder.py` do kit.

## Contexto
O avaliador constroi a cena com uma camera do Blender (`lente` em mm, sensor
36 mm, imagem 256x256). Para fazer geometria inversa sem Blender e preciso
reproduzir a projecao exatamente.

## Regra/tecnica
- Base: `X_cam` para a direita, `Y_cam` para baixo, `Z_cam` para frente.
- `f_px = lente / sensor * size` (`size` = lado da imagem). Para 24 mm e 256
  px: `f = 170.6667 px`. O sensor AUTO do Blender usa 36 mm no lado maior; em
  imagem quadrada o resultado e esse.
- Direcao de visao `D`, direita `r = normalize(D x Z_mundo)` e baixo
  `d = D x r`. Projecao: `x = cx + f*(r.P)/(D.P)`, `y = cy + f*(d.P)/(D.P)`.
- Para desprojetar um pixel, `dir_camera = K^-1 [x,y,1]`; para mundo,
  `dir_mundo = R^T dir_camera` (R leva mundo -> camera).
- Um ponto no infinito (direcao `v`) projeta em `K v` (dividir pela 3a
  coordenada), mesmo que a 3a coordenada seja negativa.

## Evidencia
- `tests/test_geometria.py::test_centro_da_imagem` e
  `test_raio_plano_recupera_ponto` passam com erro < 2e-3 m.
- Reconstrucao da `ref-A1.png`: cantos da janela reprojetados com erro ~0.2 px
  apos o ajuste fino (RMS 1.0 px incluindo todas as retas).
- Raio/parede: um pixel da linha do teto em `x=128` intersecta y=0 no ponto
  correto (ver `raio_parede_fundo`).

## Quando reutilizar
- Qualquer tarefa de visao 3D com camera calibrada: medir objetos, projetar
  marcadores, comparar render sintetico com foto.
- Reimplementar uma camera de engine (Unity/Three/Blender) em numpy.
