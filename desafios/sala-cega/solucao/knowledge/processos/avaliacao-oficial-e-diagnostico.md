# Avaliacao oficial e diagnostico

## Titulo
Usar o feedback do avaliador como medida externa, sem tentar adivinhar o
gabarito.

## Contexto
O avaliador oficial roda em branch separada e devolve nota + diagnostico
qualitativo. A metrica local e otimista; o feedback externo e a fonte de
verdade para priorizar.

## Regra/tecnica
- Registre a nota por criterio e o que ela implica:
  * B1 baixa com MAE baixa e IoU de bordas muito baixa -> orientacao/geometria
    errada (nao e so cor).
  * A1 alta -> a camera A e a aparencia estao boas; o problema esta no mundo.
  * B2 quase zero -> o programa devolveu a estrutura da cena 1; falta
    inferencia de parede/paleta/proporcao.
  * Plausibilidade <15 -> cheque bbox de planos, objetos fora, camera.
- Trate o diagnostico como hipotese: "lados trocados" sugeriu rotacao de 90
  graus; "outra parede de abertura" sugeriu inferir a parede em vez de assumir
  fundo.
- Nao tente ler arquivos do avaliador; use so a mensagem publica e o kit.
- Apos cada rodada, atualize o metodo e o `knowledge/` com a licao generica,
  nao com a nota.

## Evidencia
- Rodada 1: 62,2/100 (B1 21,3, A1 17,2, B2 1,2, plaus 12,5, eng 10).
- A combinacao "A1 0,859 + B1 0,532 + B2 0,078" foi o sinal de referencial
  errado; a correcao foi canonicalizar/rotacionar e generalizar a abertura.
- A plausibilidade 12,5 foi associada ao plano do tapete com bbox abaixo do
  piso; corrigido com `tamanho[2]=0,02`.

## Quando reutilizar
- Qualquer entrega avaliada por metrica externa + feedback qualitativo.
- Priorizar melhorias por peso (B1 40 > A1 20 > B2 15) e por sinal
  (geometria vs aparencia).
- Escrever post-mortems que separem medicao externa de metrica local.
