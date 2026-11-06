# Mascaras de cor e componentes conexas

## Titulo
Segmentar e classificar objetos por cor sem biblioteca de visao.

## Contexto
Sem OpenCV/skimage, todo o pipeline usa numpy. As mascaras por cor precisam
distinguir tapete (rosa/vermelho), sofa (azul), mesa (madeira) e janela
(branco estourado), com ruido de denoise e sobreposicao de sombras.

## Regra/tecnica
- Converta para HSV; use hue circular (0 e 360 sao vizinhos). Saturate/valor
  para cortar chao e parede.
- Corte tipico calibrado neste kit: azul `h in [190,235], s>0.15, v>0.2`;
  rosa/vermelho `h>320 ou h<12, s>0.12`; madeira `h in [8,50], 0.13<s<0.45`;
  janela `v>0.93, s<0.09`.
- Escolha a maior componente conexa (4-vizinhos), nao a uniao: sombras
  quebram o objeto e a uniao junta objetos distantes.
- Para desempenho, rotule com union-find em uma varredura; 65k pixels rodam em
  ~10 ms. Evite chamadas O(n^2).
- Pitefall: a tampa da mesa pode cair no mesmo hue do tapete. Prefira separar
  por saturacao/valor e por reinterpretacao geometrica (plano horizontal a
  0,44 m) em vez de confiar so na cor.
- Pitefall: tapete de cor palida (`s<0.12`) e indistinguivel do piso. Nao
  invente tapete: e melhor nao colocar objeto do que colocar um tapete rosa
  inexistente (custa bordas e cor).
- Pitefall: o livro azul tambem cai na mascara azul; a maior componente deve
  ser o sofa. Se so houver livro, nao crie sofa.
- Generalizacao de paleta: divida a mascara colorida em familias de matiz
  (vermelho, laranja, verde, azul, roxo) e escolha a melhor componente de cada
  familia por geometria (projecao na parede lateral para sofa; mapeamento no
  piso para tapete). Nao dependa de "azul" ou "rosa".
- Pitefall de implementacao: `_pixels(mask)` retorna `(xs, ys)`; inverter a
  ordem em `ys, xs = _pixels(...)` troca todas as coordenadas e contamina
  centroides/projecoes. Foi a causa de um tapete com geometria absurda e de um
  livro deslocado; confira a ordem em cada uso.
- A cor base dos materiais deve vir da componente detectada (media RGB), nao
  de uma cor fixa por nome; um sofa verde com base azul arruina a cena.

## Evidencia
- `ref-A1.png`: mascara azul 6.334 px (sofa + livro), rosa 12.823, madeira 952.
- Cena sintetica com sofa verde: a mascara azul fixa falhou; com familias de
  matiz + projecao na parede, o sofa verde passa a ser detectado. A cor media
  detectada alimenta o material.
- Cena sintetica com tapete rosa e sofa azul encostados: a uniao colorida virou
  uma unica componente (20.352 px) e o detector pegou o tapete como sofa. A
  separacao por familias de matiz resolveu (azul 6.254 / vermelho 12.768).
- Mesa mapeada no plano 0,44 m recuperou 1,09 x 0,57 m (coerente com a imagem).

## Quando reutilizar
- Segmentacao simples em jogos, dashboards, automacao de fotos.
- Pre-processar mascaras para medir areas/posicoes sem OpenCV.
- Quando a cor de um objeto e incerta, combine geometria (plano) com cor.
