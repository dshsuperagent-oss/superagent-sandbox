# Dataset sintetico e validacao

## Titulo
Gerar salas aleatorias com o proprio builder para testar generalizacao.

## Contexto
So vemos `ref-A1.png`; a cena reservada (A2) e desconhecida. Para nao testar
"no escuro", geramos salas sinteticas no schema, renderizamos A e B, rodamos
`reconstruir.py` e medimos a similaridade contra a cena original.

## Regra/tecnica
- Gerador: dimensoes aleatorias (L 3,7-5,2; P 3,2-4,9; H 2,5-2,85), janela no
  fundo, camera A frente-esquerda (margens 0,35-0,85 m), camera B
  frente-direita, moveis (sofa, mesa, tapete, livros, luminaria) e cores
  sorteadas em HSV plausivel.
- Renderize com o builder oficial (256x256, 64 spp) para A e B; rode o
  pipeline em A; renderize a cena reconstruida de B; compare.
- Lote/paralelismo: um unico processo Blender renderiza varios jobs
  (`batch_render.py`), 4 processos em paralelo. 16 renders 256/64 em ~22 s.
- Guarde a verdade (parametros) junto para medir erro de geometria, nao so
  imagem. Nao leia nada do avaliador: o dataset e nosso.
- Use os resultados para achar falhas sistematicas (ex.: sofa verde nao
  detectado), nao para chumbar a cena 1.

## Evidencia
- Rodada 1 (janela no fundo, paleta aleatoria, 8 salas): A medio 0,642,
  B medio 0,444. Rodada 2 (convencao sofa-no-fundo, janela lateral, paleta
  fixa): orientacao correta em 5/8; nas 3 falhas o solver caiu no fallback
  (canto/retas ambiguos) e A/B ficaram baixos. A cena 1 fica em 0,911 (acima
  da media, pois foi calibrada nela).
- O harness de convencao gera a cena canonica (janela no fundo, sofa a
  direita), gira +90 (sofa no fundo, janela esquerda) ou espelha (janela
  direita) e escolhe uma camera B plausivel. E o teste que expoe o erro de
  referencial que a vista A nao mostra.
- Falhas: sofa de cor nao-azul nao detectado; tapete palido confundido com
  piso; canto fora do quadro quebrava a geometria; a priorizacao do encosto
  do sofa melhorou A mas nem sempre B (o braco dianteiro pode estar errado).
- A cena 1 (ref-A1) fica bem acima da media sintetica (0,912), o que e
  esperado: o pipeline foi calibrado nela; a sintetica mede generalizacao.
- Tempo por imagem do pipeline: 1-3 s (bem abaixo dos 30 min).

## Quando reutilizar
- Validar qualquer modelo/pipeline quando o conjunto de teste e secreto.
- Criar regressao visual sintetica em CI.
- Medir robustez a variacoes de cor/geometria/iluminacao.
