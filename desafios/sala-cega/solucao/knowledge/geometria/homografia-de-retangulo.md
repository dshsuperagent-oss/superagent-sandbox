# Homografia de um retangulo plano

## Titulo
De um quadrilatero na imagem para proporcao e pose de um retangulo 3D.

## Contexto
A janela da sala e um retangulo numa parede. Quatro cantos na imagem bastam
para recuperar a proporcao altura/largura e a pose relativa camera-parede, a
menos de escala.

## Regra/tecnica
- Monte `H` (DLT, 4 pontos) que leva o quadrado unitario `(0,0),(1,0),(1,1),(0,1)`
  aos cantos BL,BR,TR,TL da imagem.
- `A = K^-1 H`; colunas `a1,a2,a3`. Com `R` conhecido (eixos do mundo nas
  coordenadas da camera), `a1/s ~ R[:,0]`, `a2/s ~ R[:,2]*h`, `s=|a1|`.
  Resultado: `h/w = |a2|/|a1|` e `T = a3/s` em unidades de largura da janela.
- A imagem **nao** fixa a escala metrica: `T` esta em larguras de janela.
  Fixe a escala por uma priori (altura da sala, altura tipica de janela).
- Valide sempre: `a1/s` deve coincidir com o eixo X da rotacao e `a2/s` com o
  eixo Z; erros > 5% indicam cantos/rotacao errados.

## Evidencia
- `ref-A1.png`: `h/w = 0.8706`; com altura de sala 2,70 m a janela fica
  `1,69 x 1,47 m`, peitoril 0,56 m.
- O mesmo codigo, num render sintetico de retangulo 1,6 x 1,2 m, recuperou
  `h/w = 0,75` (teste `test_decompor_janela_recupera_proporcao`).
- `decompor_janela` com R errado ainda "acerta" os cantos (T compensa), mas
  entorta a parede; por isso a rotacao vem das retas/pontos de fuga, nao da
  homografia sozinha.

## Quando reutilizar
- Medir quadros, janelas, portas, telas, folhas A4 e etiquetas em fotos.
- Inserir objetos 3D sobre um plano detectado (AR simples).
- Calibrar camera a partir de um alvo retangular.
