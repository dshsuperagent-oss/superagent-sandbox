# Plausibilidade e bounding box de planos

## Titulo
Um `plano` com `tamanho=[lx,ly,1]` e centro em z=0,012 parece abaixo do piso
para um checador ingenuo de bounding box.

## Contexto
O avaliador checa "nada abaixo do piso" e "objetos dentro da sala". Tapetes
sao `plano` no chao; o builder ignora a escala Z do plano (a malha e 2D), mas
um validador que use `centro[2] - tamanho[2]/2` ve o tapete afundado 0,49 m.

## Regra/tecnica
- Para planos horizontais, use `tamanho[2]` pequeno (0,02) e centro z=0,012:
  a bounding box fica acima do piso e o render nao muda (o builder escala o
  plano em X/Y; Z e irrelevante).
- Antes de entregar, rode a checagem de bbox para TODOS os tipos, inclusive
  `plano`, nao so cubos/esferas/cilindros.
- Objetos devem caber em `|x|<=L/2`, `|y|<=P/2`; o tapete centrado deve ser
  clampado (o primeiro ajuste ingenuo colocou `x_min=-2,69` com parede em
  -2,04).

## Evidencia
- Rodada oficial 1: plausibilidade 12,5/15 (um dos seis checks falhou). O
  tapete tinha `tamanho=[2,28, 2,78, 1]` e centro z=0,012 -> bbox inferior
  -0,49 m. Na rodada 2 passou a `tamanho[2]=0,02` (inferior 0,002 m).
- Checagem local `_validar_basico` agora testa todos os tipos e passa.
- O render do tapete e identico antes/depois (a escala Z do plano nao entra na
  malha).

## Quando reutilizar
- Entregar cenas para validadores que calculam bbox a partir de centro/tamanho.
- Qualquer schema em que a semantica de um campo difere do tipo geometrico.
- Revisar plausibilidade de cenas geradas por codigo.
