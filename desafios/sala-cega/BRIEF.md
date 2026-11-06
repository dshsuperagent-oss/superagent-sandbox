# Desafio da Sala Cega — brief oficial

Voce recebe **uma unica imagem** de uma sala 3D (`ref-A1.png`) e precisa escrever um
**programa** que reconstrua a cena por tras dela. Nao ha modelagem manual: a entrega e codigo.

## O que voce recebe

| Arquivo | O que e |
|---|---|
| `ref-A1.png` | a vista A da cena 1 (256x256). E a unica imagem da cena 1 que voce ve. |
| `builder.py` | o builder oficial (Blender) que transforma `cena.json` em render. E o contrato exato de como sua cena sera construida e renderizada. |
| `schema.py` | validador do `cena.json`. Rode `python schema.py sua-cena.json` antes de entregar. |
| `exemplo/cena.json` | cena de calibracao (SALA DIFERENTE, sem relacao com a cena 1). |
| `exemplo/vista-A.png`, `exemplo/vista-B.png` | duas vistas dessa cena de calibracao. Com o `cena.json` delas voce calibra seu modelo de aparencia (cores, sombras, tom). |
| `exemplo/camera-B.json` | a camera usada na vista B do exemplo (formato de pose). |

O gabarito (cena 1 real, cena 2 reservada e as vistas B) **nao** e entregue.

## O que voce entrega

Na raiz do seu trabalho:

1. `reconstruir.py` — CLI obrigatoria, executada pelo avaliador assim:
   ```
   python reconstruir.py --ref <imagem.png> --out <cena.json> [--seed N]
   ```
   - le **apenas** a imagem indicada em `--ref`;
   - grava a cena reconstruida em `--out` no schema v1;
   - deterministico: mesma imagem + mesmo seed -> bytes identicos;
   - roda em ate **30 minutos** por imagem, sem GUI e sem acesso a rede;
   - pode usar numpy/PIL se disponiveis; no maximo Python 3.12 + stdlib + numpy + PIL.
2. `cena.json` gerado para `ref-A1.png` (resultado do seu programa, nao editado a mao).
3. `tests/` com testes automatizados (`python -m unittest discover` deve passar).
4. `README.md` curto: como rodar, o que seu metodo faz, limitacoes.
5. **`knowledge/`** — ver secao obrigatoria abaixo.

O avaliador roda seu `reconstruir.py` em **duas** imagens: `ref-A1.png` (que voce ve) e
`ref-A2.png` (**cena reservada, que voce nunca ve**). Isso testa generalizacao: um
`cena.json` chumbado nao passa.

## Como a cena e renderizada (resumo)

O `builder.py` e a fonte da verdade. Pontos que importam:

- Sala centrada em X/Y, piso em z=0, teto em z=altura; paredes em paineis com uma abertura
  (`sala.abertura`). Parede "fundo" = y=+profundidade/2; "esquerda" = x=-largura/2.
  Em fundo/frente, `u` = x; em esquerda/direita, `u` = y.
- Se existir material chamado **`ceu`**, o builder cria um plano emissivo atras da abertura
  (o "exterior"). Sem ele, a abertura mostra apenas o world.
- Materiais: Principled BSDF com `cor`, `rugosidade`, `metalico`, `emissao` + `forca_emissao`.
- Objetos: `cubo` (tamanho = dimensoes totais), `esfera` (tamanho = diametro),
  `cilindro` (tamanho = diametro X/Y e altura Z), `plano`.
- Luzes: `sol` (direcao = sentido em que a luz viaja), `area` (posicao+alvo+energia+tamanho),
  `ponto`.
- Camera: `posicao`, `alvo`, `lente` (mm, sensor 36 mm).
- Render: Cycles CPU, 256x256, 64 spp, denoise, **AgX**, exposicao 0.

## Como a nota e calculada (publicada, sem surpresa)

Similaridade de uma vista (0..1):

```
fMAE   = clamp((0.15 - MAE) / (0.15 - 0.03))      # erro medio absoluto de cor
fBorda = clamp((IoU_bordas - 0.05) / (0.35 - 0.05))
fSSIM  = clamp((SSIM - 0.80) / (0.97 - 0.80))
similaridade = 0.50*fMAE + 0.30*fBorda + 0.20*fSSIM
```

| Componente | Peso | O que mede |
|---|---|---|
| Vista B1 (escondida) | 40 | render da SUA cena de uma camera que voce nao conhece x `ref-B1` |
| Vista A1 | 20 | sua camera A x `ref-A1` |
| Vista B2 (cena reservada) | 15 | seu programa rodado em `ref-A2`, camera escondida x `ref-B2` |
| Plausibilidade | 15 | 6 checagens geometricas no seu `cena.json` (objetos dentro da sala, nada abaixo do piso, camera dentro, >=1 luz, >=5 objetos, sala plausivel) |
| Engenharia | 10 | schema valido (2), determinismo (3), tempo (3), testes passando (2) |

Referencias de calibracao locais (execucao do avaliador em 05/11): **sala vazia = 28,7**;
**gabarito exato = 95,0**. Ou seja: 30 e "nao fez nada", 95 e "acertou quase tudo".
Meta de aprovacao: **55**.

## Regras (o avaliador tambem audita)

- Sem ler arquivos escondidos do avaliador, sem baixar a cena de fora, sem copiar imagem.
- Sem colar `ref-A1` como textura/plano: a vista B e o teste de generalizacao punem isso.
- `cena.json` so com as chaves do schema; material com imagem/textura e proibido.
- Nada de caminho absoluto para `F:\ai\_lab\desafio-sala-cega\gabarito` ou similar.

## OBRIGATORIO: conhecimento acumulado (`knowledge/`)

Tudo o que for aprendido **tem que virar conhecimento reutilizavel**, nao so resultado:

```
knowledge/
  README.md          index: titulo, quando usar, link
  grafos/            ex.: geometria 3D, camera, PBR, ray casting
  programacao/       ex.: otimizacao, metricas, testes, desempenho em Python puro
  blender/           ex.: semantica do builder, AgX, luz, armadilhas
  processos/         ex.: como investigar, como medir, como comparar renders
```

Cada entrada: `titulo`, `contexto` (problema), `regra/tecnica`, `evidencia` (numero, teste,
imagem), `quando reutilizar` (fora deste desafio). Nada de segredo, nada de dado pessoal.
Regra: **nenhum ticket fecha sem contribuir ou atualizar o indice**. Uma licao generica vale
mais que dez numeros chumbados.
