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

## Evidencia
- `ref-A1.png`: mascara azul 6.334 px (sofa + livro), rosa 12.823, madeira 952.
- Cena sintetica com sofa verde: a mascara azul falhou e o sofa nao foi
  reconstruido (similaridade B caiu ~0,1). Licao: para generalizar cores, use
  a componente saturada grande + posicao vertical, nao o hue fixo.
- Mesa mapeada no plano 0,44 m recuperou 1,09 x 0,57 m (coerente com a imagem).

## Quando reutilizar
- Segmentacao simples em jogos, dashboards, automacao de fotos.
- Pre-processar mascaras para medir areas/posicoes sem OpenCV.
- Quando a cor de um objeto e incerta, combine geometria (plano) com cor.
