# Desempenho e determinismo

## Titulo
Bytes identicos e orcamento de 30 min por imagem.

## Contexto
O avaliador exige mesma imagem + mesma seed -> bytes identicos, e ate 30 min
por imagem, sem GUI/rede.

## Regra/tecnica
- Nada de `time`, `random` sem seed, caminhos absolutos ou estado global
  mutavel. Use apenas a imagem de `--ref`.
- `json.dumps(..., sort_keys=True, indent=1)` e arredondamento para 6 casas;
  ordene a lista de objetos por nome antes de escrever.
- `maior_componente` com union-find deterministico (ordem de varredura fixa);
  `np.linalg` e determinista; nada de threads com reducao nao determinista.
- Leitura de PNG: PIL quando disponivel; fallback stdlib (zlib + filtros) para
  ambientes sem PIL. Nao dependa de scipy/Blender.
- Tempo medido: 1-3 s por imagem no nosso ambiente (256x256) — muito abaixo
  dos 30 min. O gargalo e a deteccao de componentes, nao a algebra.

## Evidencia
- `tests/test_pipeline.py::test_cli_gera_json_valido_e_deterministico`: duas
  execucoes com seeds 0 e 7 geram bytes identicos (a seed nao altera o metodo).
- `test_cena_dentro_dos_limites_temporais`: < 120 s (na pratica ~2 s).
- Saida sempre valida (inclusive fallback) — testado com imagem sintetica.

## Quando reutilizar
- Pipelines que rodam em avaliador/CI e precisam de reproducibility.
- Geracao de assets deterministicos para jogos/testes.
- Qualquer CLI que deva funcionar sem dependencias pesadas.
