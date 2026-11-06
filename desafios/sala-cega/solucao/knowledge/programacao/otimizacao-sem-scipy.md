# Otimizacao sem scipy

## Titulo
Refinar parametros com Nelder-Mead deterministico em numpy puro.

## Contexto
O avaliador garante apenas Python 3.12 + stdlib + numpy/PIL. Nao se pode
depender de scipy no `reconstruir.py`.

## Regra/tecnica
- Implemente Nelder-Mead padrao (reflexao 1, expansao 2, contracao 0,5,
  encolhimento 0,5) com clip de caixa a cada avaliacao.
- Use custo robusto (Huber): `r^2` se `|r|<=thr`, senao `2*thr*|r|-thr^2`.
  Isso impede que uma linha ruidosa (piso) domine.
- Criterio de parada: variacao de f e do simplex; `and` entre arrays quebra em
  numpy (`ValueError`), use `float(np.max(...))` e `float(...)`.
- Simplex inicial: 2% do intervalo da caixa (minimo 1e-4); se o passo colar no
  limite, ande para o outro lado.
- Para 11 parametros e ~1.000 avaliacoes o custo e ~2 s (cada avaliacao so
  projeta retas, sem rasterizar).

## Evidencia
- `ref-A1.png`: RMS de retas+cantos cai de 6,7 px (analitico) para 0,23 px
  (scipy least_squares de referencia) e 1,0 px com nosso Nelder-Mead; a
  similaridade final do render fica em 0,847 (praticamente igual ao fit com
  scipy).
- Um bug classico (`np.max(...) <= ... and ...`) derrubou a cena 14 do
  dataset sintetico; corrigido com `float(...)`.
- O otimizador e deterministico: mesma entrada -> mesmos bytes.

## Quando reutilizar
- Ambientes restritos (plugin, WASM, Lambda) sem scipy.
- Ajuste de poucos parametros com funcao barata e nao diferenciavel.
- Prototipos que precisam rodar em Python puro + numpy.
