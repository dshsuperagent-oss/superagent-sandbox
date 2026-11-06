# Calibrar com o exemplo

## Titulo
Validar a copia local do renderizador contra o kit antes de confiar em numeros.

## Contexto
O kit entrega `exemplo/cena.json` e duas vistas (A e B) com cameras conhecidas.
Se o nosso jeito de reproduzir o builder nao for exato, toda comparacao fica
suspeita.

## Regra/tecnica
- Rode o `builder.py` oficial no exemplo e compare com `vista-A.png` e
  `vista-B.png` no nivel de pixel (MAE). Se o MAE for ~0, a semantica esta
  certa.
- Verifique tambem tamanho, modo de cor e a presenca de alfa.
- Use o exemplo para calibrar aparencia (AgX, cor, sombras), pois e a unica
  cena com ground truth completo (cena + duas vistas).
- A camera A do exemplo tem uma esfera emissiva praticamente colada na lente;
  a vista A "estoura" — aprenda a reconhecer exposicao, nao "corrija" a cena.
- Rode o mesmo pipeline nas duas vistas do exemplo para achar falhas de
  deteccao (a vista B e mais "normal").

## Evidencia
- Nosso render do exemplo com o builder oficial reproduziu `vista-A.png` com
  MAE 5,4e-6 e `vista-B.png` com MAE 8,1e-6 (praticamente identicos).
- O exemplo tambem mostrou que a janela com `ceu` fica branca estourada em
  256x256/64spp, exatamente como na `ref-A1`.
- Sem essa calibracao, um erro de cor de 0,05 era interpretado como erro de
  material, quando era exposicao/AgX.

## Quando reutilizar
- Antes de fazer engenharia reversa de qualquer pipeline de render.
- Validar um wrapper/port de Blender para outro engine.
- Quando o "gabarito" e uma imagem e voce tem o gerador dela.
