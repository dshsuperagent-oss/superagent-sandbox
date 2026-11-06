# Semantica do builder

## Titulo
O que exatamente `cena.json` vira no Blender (e o que isso muda na reconstrucao).

## Contexto
O `builder.py` e o contrato. Errar 5 cm na parede ou a orientacao de um plano
muda a imagem e a comparacao.

## Regra/tecnica
- Sala centrada em X/Y, piso em z=0, teto em z=altura; parede "fundo" em
  y=+prof/2, "esquerda" em x=-largura/2; em fundo/frente `u`=x, em
  esquerda/direita `u`=y.
- Paredes sao paineis (cubos) com espessura `t` centrados no plano da parede:
  a face **interna** fica em `dim/2 - t/2` (5 cm para dentro com t=0.10).
  Para igualar a imagem, modele a face interna, nao o plano nominal.
- A abertura corta 4 paineis: esquerda, direita, baixo, cima. O material
  `ceu`, se existir, cria um plano emissivo atras da abertura (tamanho
  `max(u1-u0,0.2)+0.6` por `max(z1-z0,0.2)+0.6`) — e o "exterior" estourado.
- Primitivas: `cubo` (tamanho = dimensoes totais), `esfera` (tamanho =
  diametro), `cilindro` (diametro X/Y e altura Z), `plano` (tamanho = X/Y,
  normal +Z por padrao; rotacao_deg gira).
- Camera: campo de visao por `lente` mm e sensor 36 mm; sem distorcao.
- Render: Cycles CPU, 256x256, 64 spp, denoise, AgX, exposure 0, seed 0.
- Objetos recebem `smooth` so esfera/cilindro; cubos ficam facetados.

## Evidencia
- Reproduzimos `exemplo/vista-A.png` e `vista-B.png` localmente com MAE
  ~5e-6 (pixels praticamente identicos), confirmando a semantica.
- A face interna a `t/2` explicou ~1 px de deslocamento nas linhas de parede.
- A esfera emissiva do exemplo, com a camera A muito perto, cobre a imagem e
  "estoura" (o blob branco curvo do exemplo) — nao e bug do builder.

## Quando reutilizar
- Qualquer tarefa que gere cena para este kit/avaliador.
- Portar uma cena entre engines (lembrar das espessuras e do ceu).
- Depurar por que um render nao bate com a referencia (parede, abertura, ceu).
