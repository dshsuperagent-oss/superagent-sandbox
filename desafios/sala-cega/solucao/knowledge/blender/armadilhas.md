# Armadilhas do kit

## Titulo
Erros que custam pontos e como evita-los.

## Contexto
Lista de tropecos encontrados ao reconstruir `ref-A1.png` e ao comparar com o
builder.

## Regra/tecnica
- Espessura da parede: a face visivel e `dim/2 - t/2`; ignorar isso desloca
  linhas em ~1 px e confunde a escala.
- `plano` nasce em XY com normal +Z; para tapete no chao, `rotacao_deg=[0,0,0]`
  e z pequeno (0,01). Para "ceu" o builder gira 90 graus; nao gire de novo.
- Nao coloque objeto abaixo do piso nem fora da sala; o avaliador checa
  plausibilidade. Tapete centrado ingenuamente pode sair da sala.
- Camera dentro da sala; `alvo` e um ponto, nao um vetor. Distancia focal em
  mm, nao em pixels.
- Esfera perto da camera pode cobrir a tela e estourar (foi o que aconteceu
  na vista A do exemplo). Se a referencia tem um blob branco, considere isso.
- Denoise + AgX suavizam bordas; nao persiga bordas de 1 px. O avaliador
  compara imagens 256x256 com tolerancia.
- Nao use textura/imagem no material (proibido pelo schema) nem caminho
  absoluto.
- Sementes/ordem: Cycles com seed 0; nosso raster e deterministico; nao
  compare renders de resolucoes/spp diferentes como se fossem iguais.

## Evidencia
- Ignorar a espessura deslocou a linha do piso em ~0,7 px e mudou o peitoril
  em ~4 cm.
- Um tapete com `x_min=-2,69` (fora de L/2=2,04) parecia bom na vista A mas
  seria reprovado na plausibilidade.
- Renderizar a 160/32 durante a busca e 256/64 no final deu ranking estavel e
  economizou ~60% do tempo.

## Quando reutilizar
- Checklist antes de entregar qualquer cena para este kit.
- Revisar cenas de interiores em engines com convencoes parecidas.
- Evitar "funciona na minha vista, quebra na vista B".
