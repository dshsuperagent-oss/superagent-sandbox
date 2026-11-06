# Solucao — Desafio da Sala Cega

Reconstrucao de uma cena 3D (schema v1 do kit) a partir de **uma unica
imagem**, sem Blender, sem rede e sem modelagem manual. O programa le apenas
`--ref` e escreve `--out`.

## Como rodar

```bash
python reconstruir.py --ref ../ref-A1.png --out cena.json [--seed N]
python ../schema.py cena.json          # valida o schema do kit
python -m unittest discover            # testes (sem Blender)
```

Requisitos: Python 3.12 + numpy. PIL e opcional (ha leitor PNG em stdlib).
Tempo: ~2-3 s por imagem (orcamento do avaliador: 30 min). Deterministico:
mesma imagem/seed -> bytes identicos.

`cena.json` neste diretorio foi gerado pelo proprio programa
(`reconstruir.py --ref ../ref-A1.png --out cena.json`), nao editado a mao.

## Resultado (numeros honestos)

**Rodada oficial 1 (avaliador do dono, 05/11): 62,2/100 — passou a meta 55.**

| Criterio | Pontos | Medido |
|---|---|---|
| B1 — vista escondida (40) | 21,3 | similaridade 0,532 · MAE 0,041 · IoU bordas 0,101 |
| A1 — vista publicada (20) | 17,2 | similaridade 0,859 · MAE 0,031 · SSIM 0,885 |
| B2 — cena reservada (15) | 1,2 | similaridade 0,078 · MAE 0,131 |
| Plausibilidade (15) | 12,5 | geometria ok |
| Engenharia (10) | 10,0 | schema, determinismo, tempo, 15 testes |

Diagnostico oficial: a cena batia em A1 mas **trocava os dois lados
horizontais** (L/P), **deslocava a abertura ~0,4 m** e nao generalizava para a
cena reservada (outra parede de abertura/paleta). A rodada 2 corrige o
referencial do mundo (rotacao/reflexao), generaliza a deteccao de mobiliario
por familias de cor e ajusta a plausibilidade de planos. A nova nota oficial
ainda nao e conhecida; a metrica A1 local (abaixo) e uma aproximacao.

Medido com a nossa reimplementacao local da formula do BRIEF, comparando o
render oficial do nosso `cena.json` com `ref-A1.png`:

| Cena | Similaridade A1 | MAE | IoU bordas | SSIM |
|---|---|---|---|---|
| Sala vazia com a mesma geometria (antes) | 0,538 | 0,0891 | 0,276 | 0,849 |
| Nossa reconstrucao (depois) | **0,911** | 0,0312 | 0,570 | 0,898 |

A `ref-B1`/`ref-B2` continuam inacessiveis. Em 8 salas sinteticas proprias com
a convencao do gerador (sofa no fundo, abertura lateral), o pipeline recuperou
a parede da abertura em 5/8 casos; os 3 restantes cairam no fallback. Detalhes
e falhas em `knowledge/processos/dataset-sintetico-e-validacao.md`.

![comparacao](docs/comparacao-A1.png)

*Esquerda: sala vazia com a geometria reconstruida. Centro: `ref-A1.png`.
Direita: render oficial do nosso `cena.json`. A "sala vazia" acima e a NOSSA
baseline, nao a baseline publicada de 28,7 (sala vazia generica).*

![vista B plausivel](docs/vista-B-plausivel.png)

*Segunda camera escolhida por nos (nao e a B1 escondida): mostra que a cena e
3D de verdade, com sofa na parede do fundo, janela na lateral e tapete.*

## Metodo (o que o programa faz)

1. **Janela**: limiar de luminosidade/baixa saturacao + maiores componentes +
   bordas subpixel. Da o quadrilatero TL/TR/BR/BL.
2. **Canonicalizacao**: uma imagem de sala e invariante por rotacao/reflexao.
   Se a janela aparece a direita do canto, a imagem e espelhada antes da
   analise (e a cena e espelhada de volta no final).
3. **Retas da sala**: borda mais alta de cada coluna; duas retas de topo com
   consistencia com o ponto de fuga X da janela; aresta vertical do canto;
   linha piso-parede escolhida pela familia X (VP).
4. **Rotacao e focal**: pontos de fuga; rotacao por eixos ortogonais; lente
   24 mm como priori do kit (a imagem nao determina a escala absoluta).
5. **Janela -> parede**: homografia do retangulo da janela (proporcao e pose
   relativa camera-parede, a menos de escala).
6. **Sala**: raios ao plano da parede do fundo dao teto, peitoril e parede
   lateral; altura de sala 2,70 m fixa a escala; margens tipicas (0,35 m)
   fecham L/P/camera.
7. **Referencial do mundo**: a imagem sozinha nao distingue uma cena de sua
   rotacao em 90 graus. Usamos a convencao do gerador (sofa encostado na
   parede do fundo): no referencial canonico o sofa esta na parede direita,
   entao giramos +90 graus; se houve espelhamento, desfazemos. A janela cai
   numa parede lateral (esquerda/direita).
8. **Refino**: Nelder-Mead (numpy puro, custo Huber) das retas e cantos.
9. **Mobiliario**: familias de cor (vermelho, laranja, verde, azul, roxo),
   nao apenas azul/rosa. Sofa = componente com projecao lateral e altura de
   encosto plausiveis; tapete = componente apoiada no piso (caminho rosa
   calibrado + fallback generico); mesa pela tampa em z=0,44 m; livros no
   centro da mesa.
10. **Aparencia**: rig de luz fixo calibrado no exemplo/ref-A1 e cor base
    estimada por iteracao de medias de regiao (inversa aproximada do AgX),
    usando as cores das componentes realmente detectadas.

O codigo e um unico arquivo (`reconstruir.py`), com funcoes testaveis e
comentarios; a matematica esta detalhada em `knowledge/geometria/`.

## Limitacoes (o que pode dar errado)

- **Referencial do mundo**: a rotacao/reflexao e inferida da convencao
  "sofa na parede do fundo". Se a cena reservada nao seguir essa convencao
  (ou nao tiver sofa), a parede/rotacao pode sair trocada — e o maior risco
  para B1/B2.
- **Escala absoluta e camera**: uma imagem de sala nao fixa a escala metrica;
  usamos altura de sala 2,70 m e margens de 0,35 m como priors. A abertura
  pode deslocar ~0,4 m se as margens reais forem outras.
- **Profundidade da frente**: a parede da frente e invisivel; P vem da priori
  de margem frontal.
- **Deteccao de mobiliario**: usa cor + geometria; moveis de cor muito
  diferente passam pelas familias de matiz, mas objetos cinza/brancos e
  plantas podem nao ser detectados. Objetos pequenos vistos so na vista B
  nao entram (um objeto errado em A1 custa mais do que a ausencia em B).
- **Plausibilidade**: o plano do tapete usa `tamanho[2]=0,02` para que a
  bounding box nao fique abaixo do piso; isso e um detalhe de schema, nao
  geometria.
- **Metrica local**: nossa implementacao de bordas/SSIM difere da do
  avaliador; os numeros sao direcao, nao nota oficial.

## Arquivos

```
reconstruir.py     CLI e metodo completo (stdlib + numpy; PIL opcional)
cena.json          saida do programa para ref-A1.png
tests/             19 testes (geometria, rotacao/espelho, CLI, schema)
knowledge/         conhecimento reutilizavel (indice em knowledge/README.md)
docs/              comparacao antes/depois e vista B plausivel
```

## Testes

`python -m unittest discover` a partir deste diretorio: 19 testes, ~5 s, sem
Blender. Inclui fixture sintetica, determinismo, plausibilidade (inclusive
bounding box de planos) e a convencao de orientacao do mundo.

## Conhecimento

Ver `knowledge/README.md` (indice com titulo | quando usar | link):
geometria, programacao, blender e processos.
