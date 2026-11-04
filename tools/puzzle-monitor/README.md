# puzzle-monitor

CLI **passivo e somente leitura** para acompanhar endereços públicos de puzzles de Bitcoin e detectar mudanças de saldo ou de atividade.

O programa lê uma lista local de endereços, consulta o saldo confirmado e o número de transações em uma API pública ([mempool.space](https://mempool.space) ou [blockstream.info](https://blockstream.info)), compara com o snapshot anterior e imprime o que mudou.

> **Escopo.** Este programa não gera chaves, não assina, não transmite transações e não acessa carteiras. Ele não tem nenhuma capacidade de mover fundos. Monitorar um endereço público não cria direito sobre o saldo dele. Leia o relatório [`docs/pesquisa-cripto-perdida.md`](../../docs/pesquisa-cripto-perdida.md) antes de interpretar qualquer resultado.

## Requisitos

- Node.js 18 ou superior (usa `fetch` global).
- Nenhuma dependência externa.

## Uso

```bash
node tools/puzzle-monitor/cli.js --help
node tools/puzzle-monitor/cli.js                 # consulta os 160 endereços e grava state.json
node tools/puzzle-monitor/cli.js --dry-run       # consulta, mostra as mudanças e não grava
node tools/puzzle-monitor/cli.js --api mempool
```

A primeira execução cria o snapshot `state.json`:

```text
Monitor passivo de puzzles Bitcoin — somente leitura
Fonte: blockstream.info | 160 endereços | 2026-11-04T03:44:29.285Z

  Primeira execução: snapshot inicial com 160 endereços.
  Saldo confirmado somado: 903.01685753 BTC.

  Estado salvo em /caminho/para/state.json.
```

As execuções seguintes listam apenas o que mudou. Exemplo com fixtures offline:

```text
Monitor passivo de puzzles Bitcoin — somente leitura
Fonte: fixtures locais (offline) | 3 endereços | 2026-11-04T03:37:46.176Z

  puzzle-70  19YZECXj3SxEZMoUeJ1yiPsw8xANe7M7QR  0.00000000 BTC (8 txs)  ESVAZIADO (antes 0.70071362 BTC)
  puzzle-71  1PWo3JeB9jrGwfHDNpdGK54CRas7fsVzXU  7.10195986 BTC (72 txs)  +0.10195986 BTC, +2 txs

  Resumo: 1 alteração de saldo, 1 endereço esvaziado, 0 novos, 0 removidos.

  Estado salvo em /tmp/puzzle-state.json.
```

`ESVAZIADO` significa que o endereço tinha saldo confirmado no snapshot anterior e agora está zerado — no contexto de puzzles, é o sinal de que os fundos foram gastos. O programa não tenta descobrir quem gastou nem por quê.

## Modo offline

O modo `--offline` lê fixtures locais (`fixtures/<endereço>.json`) em vez de acessar a rede. Sem `--addresses`, ele usa `fixtures/addresses.json`. Para reproduzir o exemplo de comparação:

```bash
cp tools/puzzle-monitor/fixtures/state-previous.json /tmp/puzzle-state.json
node tools/puzzle-monitor/cli.js --offline --state /tmp/puzzle-state.json
```

As fixtures são ilustrativas e não devem ser tratadas como saldos reais.

## Opções

| Opção | Padrão | Descrição |
| --- | --- | --- |
| `--addresses <arquivo>` | `addresses.json` | Lista de endereços em JSON |
| `--state <arquivo>` | `state.json` | Snapshot anterior e destino do novo snapshot |
| `--api <nome>` | `blockstream` | `blockstream` (blockstream.info) ou `mempool` (mempool.space) |
| `--offline` | desligado | Usa fixtures locais em vez da rede |
| `--fixtures <dir>` | `fixtures` | Diretório das fixtures |
| `--delay <ms>` | `150` | Intervalo entre consultas online |
| `--timeout <ms>` | `15000` | Timeout de cada consulta |
| `--dry-run` | desligado | Não grava o snapshot |
| `--version` | — | Mostra a versão |
| `-h`, `--help` | — | Mostra a ajuda |

Se a API escolhida falhar para um endereço, o programa tenta a outra API antes de desistir. Se as duas falharem, ele encerra com código 2 e **não** grava o snapshot, para não registrar um estado parcial como se fosse completo.

## Formato de `addresses.json`

```json
{
  "addresses": [
    { "label": "puzzle-71", "address": "1PWo3JeB9jrGwfHDNpdGK54CRas7fsVzXU", "bits": 71 }
  ]
}
```

O campo `label` é livre; `bits` é opcional e serve apenas de documentação. A lista que acompanha o repositório tem os 160 endereços públicos das primeiras saídas da transação de 2015, conferidos contra a própria transação:

- transação: <https://mempool.space/tx/08389f34c98c606322740c0be6a7125d9860bb8d5cb182c02f98461e5fa6cd15>
- 256 saídas P2PKH, de 0,001 a 0,256 BTC; as 160 primeiras estão em `addresses.json`.

## Formato de `state.json`

```json
{
  "version": 1,
  "updated_at": "2026-11-04T03:40:10.178Z",
  "source": "blockstream.info",
  "addresses": {
    "1PWo3JeB9jrGwfHDNpdGK54CRas7fsVzXU": {
      "label": "puzzle-71",
      "balance_sats": 710195986,
      "tx_count": 72
    }
  }
}
```

Saldos são inteiros em satoshis; a exibição converte para BTC. O arquivo `state.json` é gerado localmente e não deve ser versionado (veja `.gitignore` nesta pasta).

## Códigos de saída

| Código | Significado |
| --- | --- |
| `0` | Consulta concluída e snapshot gravado (ou `--dry-run`) |
| `1` | Uso incorreto, arquivo inválido ou erro de gravação |
| `2` | Falha de rede/fixture; snapshot não foi gravado |

## Limites e cuidados

- **Saldo confirmado apenas.** Transações ainda na mempool são ignoradas.
- APIs públicas podem limitar requisições ou atrasar; o programa tenta novamente e alterna de API.
- Saldos mudam; o snapshot é um retrato do momento, não um título de propriedade.
- O monitor não identifica o dono de um endereço nem verifica se ele está abandonado. Um endereço sem movimento não é, por isso, "sem dono".
- O relatório do projeto explica por que se apropriar de cripto de terceiros pode ser crime no Brasil. Este programa existe para observação e pesquisa, não para apropriação.

## Fonte dos endereços e licença

Os endereços vêm da transação pública de 2015 e foram conferidos contra as saídas dela em 04/11/2026. O projeto não é afiliado ao criador do puzzle, à mempool.space nem à Blockstream.
