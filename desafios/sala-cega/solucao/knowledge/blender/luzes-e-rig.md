# Luzes e rig de iluminacao

## Titulo
Sol, area e ambiente: semantica e um rig que imita o kit.

## Contexto
A aparencia de uma sala e 80% iluminacao. O avaliador usa Cycles; a cena 1
tem janela estourada, paredes quentes e uma mancha clara na parede esquerda.

## Regra/tecnica
- `sol`: `direcao` e o SENTIDO em que a luz viaja (ex.: (0,3,-0,8,-0,5) vem
  de tras/frente e desce). Energia em W/m2, `angulo_graus` controla a maciez
  da sombra. Para luz entrar pela janela do fundo, a direcao precisa de -Y.
- `area`: `posicao`, `alvo`, `energia`, `tamanho`; a luz de area e INVISIVEL
  para a camera no Cycles (nao aparece como objeto). Para um brilho visivel,
  use malha com material emissivo (`luz`).
- `ponto`: posicao, energia, raio; sombra dura/curta.
- Ambiente (world): cor e forca; 0,2-0,35 e um preenchimento frio plausivel.
- Rig calibrado neste kit: sol dir (-0,55,-0,55,-0,63), 2,7, angulo 6
  graus, cor quente; area na janela 52,5, tamanho 1,5, azulada; area/lampada
  desligada (0); ambiente (0,6,0,72,0,9) forca 0,3; ceu emissivo 8.
- A mancha clara na parede esquerda da `ref-A1` e consistente com luz solar
  entrando pela janela e batendo na parede esquerda (direcao com -X), nao
  necessariamente uma luminaria.

## Evidencia
- Com o rig acima a parede fica em ~182 (ref 182), teto ~195 (ref 196),
  janela 245 (ref 238); similaridade A1 0,912 (a maior parte do ganho veio
  da geometria do sofa, mas o rig foi ajustado junto).
- Mover a area/lampada 30 cm mudou a mancha da parede esquerda e custou
  ~0,01 de similaridade; desligar a lampada (energia 0) subiu de ~0,886 para
  ~0,893 no ajuste de 256 px — rig tambem e geometria.
- Area light invisivel: um render sem nenhum objeto emissivo nao mostra a
  fonte, so a luz; nao confunda "nao vejo a lampada" com "nao ha luz".

## Quando reutilizar
- Montar iluminacao de interiores em Blender/Three/Unity.
- Reproduzir a "cara" de uma foto com poucas luzes.
- Depurar sombras duras/moles e fontes invisiveis.
