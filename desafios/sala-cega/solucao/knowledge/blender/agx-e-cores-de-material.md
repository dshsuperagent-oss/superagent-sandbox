# AgX e cor de material

## Titulo
Cor base linear -> pixel sRGB com AgX (e como calibrar sem implementar AgX).

## Contexto
`cor` no material e Base Color linear; o render aplica AgX + sRGB. A mesma
cor base parece muito mais clara/estourada que o esperado, e as vezes
dessaturada. Para acertar a aparencia da referencia e preciso inverter isso.

## Regra/tecnica
- Comece com um chute de cor base (ex.: parede 0,8; piso 0,45; sofa 0,3/0,45/0,7).
- Renderize, meca a media por regiao (mascara de ids do rasterizador ou
  segmentacao), compare com a referencia e atualize
  `base_nova = base_velha * ((alvo+0,03)/(atual+0,03))^1.8`, com clamp.
- Repita 3-6 vezes; a convergencia estabiliza. Esse expoente 1,8 aproxima a
  inversa local do AgX/sRGB na faixa 0,2-0,9.
- Nao otimize so a media: sombras e manchas de luz dominam SSIM. Use a media
  para a cor e o render completo para decidir.
- Materiais com `emissao`/`forca_emissao` (ceu, luz) saturam rapido; se o
  branco da janela esta 255, aumentar a forca so muda o halo, nao o miolo.
- AgX dessatura altas luzes; um sofa azul escuro pode ficar cinza-azulado.

## Evidencia
- `ref-A1.png`: com 5 iteracoes a similaridade A1 subiu de 0,745 para 0,842
  (MAE 0,065 -> 0,043); as cores base convergiram para parede
  (0,89/0,85/0,78), piso (0,23/0,21/0,23), sofa (0,11/0,22/0,47).
- A janela (ceu) fica em 235-243 na referencia; nosso render em 240-248.
  Nao perseguir 255: o denoise e o AgX criam um gradiente.
- A mesma cor base sob duas luzes diferentes muda muito; calibre material e
  luz separadamente (primeiro rig, depois cor, depois refinamento).

## Quando reutilizar
- Acertar cor de material em render fotorrealista a partir de uma foto.
- Calibrar visualizacao de dados/cores em engines com tone mapping.
- Explicar por que "a cor no arquivo nao e a cor na tela".
