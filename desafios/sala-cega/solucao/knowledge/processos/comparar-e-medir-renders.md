# Comparar e medir renders

## Titulo
Ciclo olhar -> numero -> decisao (sem se enganar com uma metrica).

## Contexto
Reconstrucao inversa tem muitas iteracoes. Olhar a imagem e bom para achar o
tipo do erro; a metrica e boa para saber se a mudanca melhorou.

## Regra/tecnica
- Sempre gere lado a lado referência | nosso render | diferenca; olhe primeiro
  a estrutura (linhas, janela, moveis) e depois a cor.
- Meça MAE, IoU de bordas e SSIM na mesma resolucao e recorte. Guarde o numero
  de cada tentativa (planilha/JSON), nao confie na memoria.
- Use mascaras por id (rasterizador) para comparar regioes especificas
  (parede, piso, tapete, sofa, mesa) e entender *onde* o erro esta.
- Cuidado com overfitting: uma mudanca que sobe a metrica mas cria geometria
  impossivel (tapete fora da sala, sofa gigante) deve ser descartada.
- Para geometria, prefira residuo de retas/cantos (px) a MAE; para aparencia,
  prefira MAE/SSIM; para forma, bordas/mascaras.
- Renderize em 160/32 para busca e 256/64 para decisao final.

## Evidencia
- A1: similaridade 0,745 (chute) -> 0,842 (cores) -> 0,902 (sofa com
  encosto/bracos corretos) -> 0,912 (tapete); o ganho grande veio de geometria
  (sofa), nao de cor.
- Um ajuste de sofa/tapete com mascaras de uniao subiu IoU mas colocou o
  tapete fora da sala; descartado (a metrica de imagem nao penaliza
  plausibilidade).
- Comparar a vista A e a B sinteticas mostrou que um erro de 0,3 m na camera
  quase nao muda A mas muda B — por isso B1 vale 40 e A1 20.

## Quando reutilizar
- Avaliar mudancas visuais em produto (design system, jogos, render).
- Testar um pipeline de reconstrucao/segmentacao com ground truth.
- Qualquer otimizacao de imagem em que "parece melhor" precisa de numero.
