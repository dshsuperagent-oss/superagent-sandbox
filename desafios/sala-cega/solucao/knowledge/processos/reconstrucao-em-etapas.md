# Reconstrucao em etapas

## Titulo
Ordem de implementacao/depuracao que funcionou.

## Contexto
Um pipeline inverso (imagem -> cena) tem muitas partes; tentar otimizar tudo
de uma vez gera resultados que "parecem" certos e generalizam mal.

## Regra/tecnica
1. Reproduza o renderer oficial e valide no exemplo (MAE ~0).
2. Detecte a janela com precisao subpixel (e a ancora de tudo).
3. Recupere rotacao/focal por pontos de fuga e valide reprojetando as linhas.
4. Resolva a parede do fundo (teto, piso, canto) e a escala por priori.
5. Refine as retas/cantos (Nelder-Mead/Huber) e cheque RMS em px.
6. Detecte mobiliario com geometria (piso/parede) e familias de cor, nao um
   matiz fixo.
7. Resolva o referencial do mundo (rotacao/reflexao) usando a convencao do
   gerador; a vista A nao distingue.
8. Calibre aparencia (rig, depois cores) com render de verdade.
9. So entao rode o dataset sintetico (incluindo variacoes de parede/rotacao)
   e conserte falhas sistematicas.
- Em cada etapa, escreva o numero de validacao (px, IoU, similaridade) no
  relatorio. Se a etapa A esta ruim, nao tente compensar em B.

## Evidencia
- Seguir a ordem levou a `ref-A1` de 0,27 (chute) para 0,91 em ~1 dia de
  iteracoes; a rodada 2 manteve 0,911 mas trocou o referencial do mundo
  (janela esquerda, sofa no fundo) para atacar B1/B2.
- Pular a etapa 2/3 e "otimizar tudo" produziu uma cena com janela no chao e
  camera baixa (similaridade 0,43, geometricamente impossivel).
- O dataset sintetico (etapa 8) expos falhas que a cena 1 escondia (cores e
  canto fora do quadro).

## Quando reutilizar
- Qualquer projeto de visao/render inverso (NeRF-like, calibracao, AR).
- Depuracao de pipelines longos: isole e valide cada transformacao.
- Planejar tempo: as etapas baratas primeiro, as caras (dataset) por ultimo.
