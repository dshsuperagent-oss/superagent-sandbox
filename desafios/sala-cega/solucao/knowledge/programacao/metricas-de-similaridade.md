# Metricas de similaridade

## Titulo
MAE, bordas (IoU) e SSIM para decidir se um render melhorou.

## Contexto
O BRIEF define a nota: `0,50*fMAE + 0,30*fBorda + 0,20*fSSIM`, com
`fMAE=clamp((0,15-MAE)/0,12)`, `fBorda=clamp((IoU-0,05)/0,30)`,
`fSSIM=clamp((SSIM-0,80)/0,17)`. Precisamos de uma implementacao local para
comparar iteracoes (o avaliador tem a dele).

## Regra/tecnica
- Trabalhe em float [0,1]; MAE medio sobre RGB.
- Bordas: magnitude de Sobel/gradiente com limiar ~0,035 (256px); IoU com
  dilatacao de 1 px dos dois lados (tolerancia a 1 px de deslocamento).
- SSIM: cinza, janela gaussiana 11, sigma 1,5, `C1=0,01^2`, `C2=0,03^2`.
- Atencao aos limites: com bordas o `fBorda` satura em IoU=0,35. Numa cena
  boa (IoU 0,49) o ganho de bordas ja e maximo; o que resta e MAE/SSIM.
- Nao otimize a metrica local como se fosse a do avaliador: use-a para
  ranking/direcao, nao para "provar" a nota final.
- Compare sempre a mesma resolucao (256) e o mesmo recorte.

## Evidencia
- `ref-A1.png` x nossa reconstrucao final (rodada 2): MAE 0,0312, IoU 0,570,
  SSIM 0,898 -> similaridade local 0,911; sala vazia com a mesma geometria
  0,538. A evolucao foi 0,840 (primeiro fit), 0,847 (borda do tapete), 0,902
  (sofa/encosto), 0,912 (rodada 1) e 0,911 (rodada 2, com dois livros).
- Calibracao publicada do avaliador: sala vazia 28,7; gabarito 95,0. A metrica
  local deu 0,91, mas o avaliador oficial mediu A1=0,859 na rodada 1: a nossa
  metrica e otimista. Use-a para ranking, nao como nota.
- O ajuste de cor por media de regiao subiu a similaridade de 0,745 para
  0,842 em 5 iteracoes (MAE 0,065 -> 0,043).

## Quando reutilizar
- Comparar versoes de um renderizador ou pipeline de imagem.
- Escolher entre alternativas de uma cena sem abrir o olho em cada uma.
- Medir regressao visual em CI (com limiares e imagem de referencia).
