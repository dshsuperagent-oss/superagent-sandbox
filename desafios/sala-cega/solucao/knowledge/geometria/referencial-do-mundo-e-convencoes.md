# Referencial do mundo e convencoes

## Titulo
Uma imagem de sala nao determina a rotacao/reflexao do mundo; a convencao do
gerador (onde fica o sofa) quebra a simetria.

## Contexto
A vista A e uma unica camera. Girar a sala inteira (paredes, moveis, camera,
luzes) em 90/180/270 graus ou espelhar em X produz a MESMA imagem. O avaliador,
porem, renderiza de uma camera B fixa no referencial do gabarito: escolher o
referencial errado derruba B1/B2 mesmo com A1 perfeita.

## Regra/tecnica
- Canonicalize a imagem: se a janela aparece a direita do canto entre as duas
  linhas de topo, espelhe a imagem antes de medir; no fim, espelhe a cena de
  volta.
- No referencial canonico, a parede lateral visivel fica a direita (+X) e a
  janela na parede do fundo (+Y).
- Aplique a convencao do gerador: o sofa fica encostado na parede do **fundo**.
  Entao gire a cena +90 graus: a parede direita (sofa) vira fundo (+Y) e a
  janela vira parede **esquerda** (-X), com `u` inalterado.
- Se a imagem foi espelhada, apos o giro +90 espelhe a cena em X: o sofa
  continua no fundo e a janela vira **direita**.
- Gire camera e luzes junto com a sala (sol, areas, alvos); assim a vista A
  fica invariante e a vista B usa o referencial certo.
- Reflexao so e valida quando a imagem de entrada tambem foi refletida: o
  render da camera A precisa continuar batendo com a imagem original.

## Evidencia
- Rodada oficial 1: a cena batia em A1 (0,859) mas o avaliador viu L/P
  trocados e abertura deslocada; B1 0,532 e B2 1,2. Era exatamente a simetria
  de 90 graus nao resolvida.
- Rodada 2 (nosso teste): `cena.json` com `largura=4,171` e
  `profundidade=4,077` (invertidos em relacao a rodada 1), abertura em
  `parede="esquerda"`, camera A em (1,88, -1,63). O render de A1 continua
  identico (similaridade local 0,911), como esperado por invariancia.
- Teste unitario: 4 rotacoes de 90 graus voltam ao original; espelho duplo
  idem (`tests/test_geometria.py::TestRotacaoEEspelho`).
- Cena sintetica com janela na direita: o pipeline espelha, reconstroi, gira e
  espelha de volta; a camera A da cena final reproduz a imagem espelhada.

## Quando reutilizar
- Reconstrucao 3D de interior a partir de uma foto com camera B desconhecida.
- Fotogrametria onde o referencial global e arbitrario (SfM sem GPS).
- Qualquer avaliacao que compare a cena em um referencial fixo: declare a
  convencao e teste rotacoes/reflexoes.
