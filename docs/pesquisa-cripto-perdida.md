# Pesquisa: criptomoedas "perdidas sem dono" — o que é possível e o que a lei permite

> Relatório técnico e jurídico de apoio ao monitor passivo em [`tools/puzzle-monitor/`](../tools/puzzle-monitor/README.md). O escopo é estritamente legítimo e somente leitura: nenhuma chave privada, nenhuma assinatura, nenhuma transação e nenhuma apropriação de fundos de terceiros.
>
> Levantamento e consultas on-chain em **04/11/2026**. A seção [O que foi verificado](#9-o-que-foi-verificado-e-o-que-não-foi) separa os dados conferidos em fonte primária das limitações. Nada aqui é promessa de enriquecimento nem aconselhamento jurídico individual.

## Conclusão em uma página

1. **Chave privada perdida é irrecuperável.** O endereço Bitcoin é o hash de uma chave pública. Sem a chave (ou a seed que a gera), não existe "reset de senha", "recuperação pela blockchain" ou autoridade central que devolva o acesso. A busca por força bruta é inviável para chaves normais e só é discutível em desafios públicos com espaço de busca pequeno e conhecido.
2. **Não existe uma categoria jurídica de "cripto sem dono".** Inatividade não é abandono; um saldo parado continua sendo propriedade de alguém. As categorias reais são: (a) dinheiro matemática e definitivamente inacessível; (b) dinheiro de terceiros (chaves fracas/vazadas, endereços de exchanges, carteiras dormentes); (c) dinheiro sem valor (testnet); e (d) processos de reembolso dos quais só o credor participa (ex.: Mt. Gox).
3. **Apropriar-se pode ser crime.** No Brasil, a analogia mais próxima é a apropriação de coisa achada (Código Penal, art. 169, parágrafo único, II), com pena de detenção de um mês a um ano ou multa, além do dever civil de restituição. Para chaves fracas/vazadas, o enquadramento pode ser mais grave: furto qualificado mediante fraude ou abuso de confiança (art. 155, § 4º, II), com pena de dois a oito anos; a movimentação posterior pode ainda configurar lavagem de dinheiro (Lei 9.613/98). A rastreabilidade pública da blockchain torna a impunidade improvável em operações relevantes.
4. **Ferramentas e "especialistas" que prometem achar carteira abandonada são fraude.** Se o método funcionasse, não seria vendido por uma taxa módica; o roteiro típico é cobrar adiantamento, pedir seed/chave ou aplicar o golpe da "recuperação" sobre quem já foi vítima.
5. **O que é legítimo e útil:** monitorar passivamente desafios públicos (este repositório), recuperar as **próprias** carteiras, cuidar de backup e sucessão, e analisar dados públicos. Nada disso cria direito sobre o dinheiro de outra pessoa.

**Resposta direta:** não é possível, de forma legítima, "encontrar criptomoeda perdida sem dono" e ficar com ela. O que existe é dinheiro inacessível, dinheiro de terceiros ou dinheiro sem valor. A conclusão é desconfortável de propósito: o valor desta pesquisa está em evitar perda de tempo e problemas legais, não em prometer retorno.

## 1. Por que uma carteira com chave perdida é irrecuperável

Uma carteira Bitcoin não "guarda" moedas. A blockchain registra saídas (UTXOs) associadas a condições de gasto; para gastar, é preciso uma assinatura válida com a chave privada correspondente. O endereço é derivado da chave pública:

```text
chave privada (256 bits)
      │  multiplicação de ponto na curva secp256k1
      ▼
chave pública (ponto na curva)
      │  SHA-256
      ▼
hash de 256 bits
      │  RIPEMD-160
      ▼
HASH160 (160 bits)
      │  Base58Check (endereços "1..."/"3...") ou bech32 ("bc1...")
      ▼
endereço
```

Esse encadeamento é de mão única. A curva secp256k1 tem ordem de aproximadamente `1,158 × 10^77`, isto é, cerca de `2^256` chaves privadas possíveis ([Bitcoin Wiki — secp256k1](https://en.bitcoin.it/wiki/Secp256k1)). O endereço, porém, tem apenas 160 bits de hash ([Bitcoin Wiki — Technical background of version 1 Bitcoin addresses](https://en.bitcoin.it/wiki/Technical_background_of_version_1_Bitcoin_addresses)). Isso não facilita a vida de quem perdeu a chave:

- Para uma carteira normal, achar **alguma** chave que produza o endereço é um problema de pré-imagem de 160 bits: cerca de `2^160` tentativas em média. É inviável.
- Para um desafio cujo intervalo de chaves é público, o custo cai para o tamanho do intervalo — no puzzle #71, `2^70` candidatos.
- Não há "senha mestra", backdoor, central de atendimento ou transação de recuperação. A seed (BIP-39) é a representação legível da chave; perdê-la é equivalente a perdê-la ([BIP-39](https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki)).

É por isso que golpes de "recuperação de carteira" funcionam: eles exploram a esperança de que a matemática tenha uma exceção. Não tem. Um serviço legítimo de recuperação só pode trabalhar com material que o dono ainda possui (seed parcial, backup, dispositivo, senha de carteira) — nunca "descobrindo" a chave na blockchain.

## 2. As categorias reais e o que é possível fazer com cada uma

| Categoria | O que é | Dá para "achar e ficar"? | O que é possível fazer |
| --- | --- | --- | --- |
| Puzzle público de Bitcoin | Endereços criados em 2015 com chaves em intervalos conhecidos; desafio aberto | Não por este projeto; quem resolver o desafio encontra a chave — e o puzzle é público justamente para isso. A situação jurídica de quem reivindica o prêmio é discutível e não é o objeto deste repositório | Monitorar passivamente; estudar a matemática; participar de pools só com consciência de que é loteria |
| Endereço de queima | Saída comprovadamente não gastável (OP_RETURN) ou endereço sem chave conhecida | Não: não há chave para usar | Nada além de observar; queimar é destruir, não "esconder" |
| Chaves fracas/vazadas | Brainwallets, bug do `SecureRandom` do Android (2013), chaves expostas em vazamentos | **Não** — são fundos de terceiros; apropriar-se é crime, não "achado" | Avisar o dono quando identificável; nunca varrer/sacar |
| Forks e airdrops não reivindicados | Moedas criadas em forks (BCH, BSV, BTG etc.) ou distribuições com regras de elegibilidade | Só para as **suas** chaves; para as dos outros, não | Reivindicar o que é seu; acompanhar processos de reembolso (ex.: Mt. Gox) |
| Testnet | Rede de testes, moedas sem valor de mercado | Não faz sentido: não há valor | Experimentar, aprender, usar faucets |
| Carteira dormente / exchange | Saldo parado, conta antiga, exchange extinta | **Não** — continua sendo de alguém | Contatar a exchange, o dono ou as autoridades; nunca invadir |

### 2.1 Puzzle público de Bitcoin (#71 e o status dos resolvidos)

Em janeiro de 2015, uma transação pública criou 256 saídas P2PKH com valores de 0,001 a 0,256 BTC — 32,896 BTC no total ([transação 08389f34…](https://mempool.space/tx/08389f34c98c606322740c0be6a7125d9860bb8d5cb182c02f98461e5fa6cd15)). Cada saída virou um "puzzle": a chave privada está em um intervalo que dobra a cada número. Os rastreadores públicos listam as 160 primeiras, que vão de 1 a 160 bits ([BTC Puzzle](https://btcpuzzle.info/puzzle)).

O **puzzle #71** é o primeiro ainda não gasto na faixa que monitoramos:

- endereço: [`1PWo3JeB9jrGwfHDNpdGK54CRas7fsVzXU`](https://mempool.space/address/1PWo3JeB9jrGwfHDNpdGK54CRas7fsVzXU)
- intervalo da chave: `2^70` a `2^71 − 1` — cerca de `1,18 × 10^21` candidatos
- valor original em 2015: **0,071 BTC**
- saldo confirmado em 04/11/2026: **7,10195986 BTC**, em 72 transações, com **zero** saídas gastas (os depósitos adicionais, em grande parte doações, explicam a diferença)

Os endereços #64 a #70 já foram gastos, como mostra o snapshot do monitor:

| Puzzle | Endereço | Saldo confirmado (BTC) | Txs | Situação |
| --- | --- | ---: | ---: | --- |
| #64 | `16jY7qLJnxb7CHZyqBP8qca9d51gAjyXQN` | 0 | 17 | já gasto (resolvido) |
| #65 | `18ZMbwUFLMHoZBbfpCjUJQTCMCbktshgpe` | 0 | 11 | já gasto (resolvido) |
| #66 | `13zb1hQbWVsc2S7ZTZnP2G4undNNpdh5so` | 0 | 50 | já gasto (resolvido) |
| #67 | `1BY8GQbnueYofwSuFAT3USAhGjPrkxDdW9` | 0 | 13 | já gasto (resolvido) |
| #68 | `1MVDYgVaSN6iKKEsbzRUAYFrYJadLYZvvZ` | 0 | 29 | já gasto (resolvido) |
| #69 | `19vkiEajfhuZ8bs8Zu2jgmC6oqZbWqhxhG` | 0 | 26 | já gasto (resolvido) |
| #70 | `19YZECXj3SxEZMoUeJ1yiPsw8xANe7M7QR` | 0 | 7 | já gasto (resolvido) |
| **#71** | **`1PWo3JeB9jrGwfHDNpdGK54CRas7fsVzXU`** | **7,10195986** | **72** | **não gasto** |

No total, dos 160 endereços monitorados, **83 estavam zerados** (já gastos) e **77 ainda tinham saldo**, somando 903,01685753 BTC em 04/11/2026. O site de acompanhamento indicava 79 puzzles resolvidos na mesma data ([BTC Puzzle](https://btcpuzzle.info/puzzle)); a diferença é o retrato de cada fonte — o que importa aqui é o dado on-chain, não o placar.

O ponto técnico decisivo: **o endereço #71 nunca gastou, então a chave pública dele não é pública**. O endereço é um hash da chave pública; sem uma saída que revele a chave pública, não se pode usar o atalho do algoritmo de Pollard (kangaroo), que resolveria um intervalo de `2^70` em cerca de `2 × √N ≈ 2^36` operações de grupo **se** a chave pública fosse conhecida ([JeanLucPons/Kangaroo](https://github.com/JeanLucPons/Kangaroo)). Sem ela, resta a busca por força bruta: derivar o endereço de cada chave candidata. Um pool público descreve o mesmo quadro: a chave pública não está exposta, então o único caminho é a busca por força bruta no intervalo ([BitcoinTalk — pool do puzzle #71](https://bitcointalk.org/index.php?topic=5588240.0)).

Isso não torna o puzzle "terra de ninguém": ele é um desafio público criado para ser resolvido, mas o projeto deste repositório **não reivindica o prêmio**. O monitor apenas observa. Se alguém resolver, a chave e os fundos serão dessa pessoa; o banco de dados público não muda esse fato.

### 2.2 Endereço de queima

Há duas formas principais de "queimar" bitcoin:

1. **OP_RETURN**: uma saída marcada pelo consenso como inválida, portanto **provadamente não gastável** ([Bitcoin Wiki — OP_RETURN](https://en.bitcoin.it/wiki/OP_RETURN)). Queimar é destruir; não há chave a recuperar.
2. **Endereço sem chave conhecida**, como [`1BitcoinEaterAddressDontSendf59kuE`](https://mempool.space/address/1BitcoinEaterAddressDontSendf59kuE), que acumulava **13,41880759 BTC** em 5.675 transações em 04/11/2026, com zero gasto. Não se conhece a chave privada; o endereço funciona como "lixeira" da comunidade.

A existência de saldo em endereço de queima não é um achado: é dinheiro destruído de propósito. Nenhuma ferramenta séria promete "recuperar" isso.

### 2.3 Chaves fracas e vazadas: fundos de terceiros, não "achado"

Dois casos históricos explicam por que essa categoria é a mais perigosa:

- **Brainwallets**: carteiras cuja chave é derivada de uma frase memorizável. Frases comuns foram varridas por bots há anos; o estudo *The Bitcoin Brain Drain* (2016) documenta o uso e o abuso desse modelo ([Vasek et al., FC 2016](https://jbonneau.com/doc/VBCKM16-FC-bitcoin_brain_wallets.pdf)). A carteira pode parecer "abandonada", mas o dono original (ou um terceiro que já a varreu) continua sendo o titular.
- **Bug do `SecureRandom` no Android (2013)**: a geração de números aleatórios do Android tinha falhas críticas, tornando vulneráveis as carteiras geradas na época. O alerta do Bitcoin.org recomendou rotação de chaves a todos os usuários ([Bitcoin.org — Android Security Vulnerability, 11/08/2013](https://bitcoin.org/en/alert/2013-08-11-android)); o problema foi explicado pelo time do Android ([Android Developers Blog — Some SecureRandom Thoughts](https://android-developers.googleblog.com/2013/08/some-securerandom-thoughts.html)). Quem varreu essas carteiras na época cometeu furto; quem repetir hoje comete o mesmo crime.

Aqui não há "coisa achada": há um bem alheio, com dono, e uma vulnerabilidade que permite subtraí-lo. A lei não transforma invasão em achado. Mesmo que o dono nunca reclame, a conduta continua típica.

### 2.4 Forks, airdrops e reembolsos (Mt. Gox)

- **Forks**: quem tem a chave de uma carteira Bitcoin pode reivindicar as moedas correspondentes em forks que preservaram o histórico (BCH, BSV, BTG etc.). Isso vale para **as suas** chaves; as moedas de fork de outra pessoa continuam sendo dela ([Bitcoin Cash](https://bitcoincash.org/)).
- **Airdrops**: distribuições costumam ter regras de elegibilidade, prazos e tesouraria. "Não reivindicado" não significa "livre para quem encontrar".
- **Mt. Gox**: o caso é de reembolso de credores, não de achado. Após o colapso de 2014, o processo de reabilitação civil organiza pagamentos em **BTC e BCH**; o trustee prorrogou os prazos de pagamento para **31/10/2027** ([MTGOX — avisos oficiais](https://www.mtgox.com/)). Só quem é credor habilitado participa. Nenhum "caçador" de fora entra nessa fila.

### 2.5 Testnet

Testnet é uma rede separada, sem valor de mercado, usada para desenvolvimento e testes; as moedas vêm de faucets e não têm relação com o Bitcoin da mainnet ([Bitcoin Wiki — Testnet](https://en.bitcoin.it/wiki/Testnet)). É um ambiente legítimo para aprender, mas não é uma fonte de renda nem um esconderijo de riqueza.

## 3. Viabilidade computacional honesta

### 3.1 O que significam os números

Para o puzzle #71, o intervalo tem `2^70 ≈ 1,18 × 10^21` chaves. A uma taxa otimista de **1 bilhão de chaves por segundo** em uma GPU, o tempo esperado para varrer o intervalo é:

```text
2^70 / 10^9 ≈ 1,18 × 10^12 segundos ≈ 37.400 anos
```

O consumo de energia correspondente, a 300 W por GPU, seria da ordem de **98 GWh** — a US$ 0,10/kWh, algo como **US$ 10 milhões** em eletricidade, contra um prêmio de 7,1 BTC. É uma estimativa de ordem de grandeza, não um orçamento: farms maiores reduzem o tempo linearmente, mas multiplicam o custo.

### 3.2 Hashrate da rede não é um atalho

O hashrate da rede Bitcoin estava em **≈ 1,01 × 10^21 H/s** em 04/11/2026 ([mempool.space — hashrate](https://mempool.space/graphs/mining/hashrate-difficulty)). Como `2^71 ≈ 2,36 × 10^21`, a rede inteira calcula `2^71` hashes SHA-256d em poucos segundos — mas isso **não** resolve o puzzle:

- o hashrate mede SHA-256d sobre cabeçalhos de bloco, não multiplicação de ponto elíptico + SHA-256 + RIPEMD-160 por candidato;
- não há como "emprestar" esse poder para derivar endereços de chaves privadas em massa sem hardware e energia dedicados;
- a comparação serve só para dimensionar `2^71`, não para sugerir que a rede "quebre" o desafio.

### 3.3 Quando o "kangaroo" ajudaria — e quando não ajuda

Pollard's kangaroo resolve o problema do logaritmo discreto em um intervalo conhecido com cerca de `2 × √N` operações; na implementação de referência, a média fica entre `2,16 × √N` e `3,55 × √N`, dependendo da configuração ([JeanLucPons/Kangaroo](https://github.com/JeanLucPons/Kangaroo)). Para `N = 2^70`, isso é da ordem de `2^36` operações. O atalho, porém, exige a **chave pública** `Q = k·G`. O endereço P2PKH do #71 nunca foi gasto e não revela `Q`; logo, o atalho não se aplica. Essa é a diferença entre "um desafio de 71 bits" e "um hash de 160 bits": sem a chave pública, o problema volta a ser busca de pré-imagem.

### 3.4 Pools e a loteria honesta

Pools de GPU dividem o intervalo e somam poder de cálculo, mas o retorno esperado continua sendo uma loteria: o custo de eletricidade tende a superar o prêmio, e a probabilidade individual é minúscula. O próprio pool do #71 se apresenta como uma loteria de longo prazo, não como fonte de renda ([BitcoinTalk](https://bitcointalk.org/index.php?topic=5588240.0)). Isso é compatível com curiosidade científica e experimentação; não é um plano de enriquecimento.

## 4. Enquadramento jurídico brasileiro

**Aviso:** esta seção é informativa e não substitui a consulta a um advogado. Não localizei lei ou precedente específico sobre "criptomoeda achada"; a análise usa as normas mais próximas e a interpretação predominante. A conclusão prática, porém, é robusta: não há base legal para se apropriar de cripto de terceiros.

### 4.1 Apropriação de coisa achada — Código Penal, art. 169, parágrafo único, II

O Código Penal tipifica a conduta de quem encontra coisa alheia perdida e dela se apropria, deixando de restituí-la ao dono ou de entregá-la à autoridade competente no prazo de quinze dias:

> **Art. 169.** Apropriar-se alguém de coisa alheia vinda ao seu poder por erro, caso fortuito ou força da natureza:
> Pena — detenção, de um mês a um ano, ou multa.
> **Parágrafo único.** Na mesma pena incorre:
> I — quem acha tesouro em prédio alheio e se apropria, no todo ou em parte, da quota a que tem direito o proprietário do prédio;
> **II — quem acha coisa alheia perdida e dela se apropria, total ou parcialmente, deixando de restituí-la ao dono ou legítimo possuidor ou de entregá-la à autoridade competente, dentro no prazo de quinze dias.**

Fonte oficial: [Código Penal — Planalto](https://www.planalto.gov.br/ccivil_03/decreto-lei/del2848compilado.htm). O TJDFT resume a aplicação e derruba o ditado popular "achado não é roubado" ([TJDFT — "Achado não é roubado"](https://www.tjdft.jus.br/institucional/imprensa/campanhas-e-produtos/direito-facil/edicao-semanal/achado-nao-e-roubado)).

**Como isso se aplica a cripto?** A lei fala em "coisa alheia perdida", uma formulação pensada para bens corpóreos. Criptoativos são bens digitais; a doutrina discute se são "coisa móvel" para fins penais. A analogia mais próxima é esta: se você encontra uma seed, uma chave ou um acesso a saldo de outra pessoa e decide usá-lo em vez de devolver, a conduta se encaixa no núcleo do art. 169, parágrafo único, II (apropriar-se de bem alheio perdido e não restituir). Não é um "achado" sem consequências.

### 4.2 Furto qualificado — Código Penal, art. 155, § 4º, II

Para chaves fracas/vazadas, o enquadramento pode ser mais grave. Subtrair coisa alheia móvel é furto; se a subtração é cometida com abuso de confiança ou mediante fraude, a pena é de reclusão de dois a oito anos, além de multa:

> **Art. 155.** Subtrair, para si ou para outrem, coisa alheia móvel:
> Pena — reclusão, de um a quatro anos, e multa.
> **§ 4º.** A pena é de reclusão de dois a oito anos, e multa, se o crime é cometido:
> I — com destruição ou rompimento de obstáculo à subtração da coisa;
> **II — com abuso de confiança, ou mediante fraude, escalada ou destreza;**
> III — com emprego de chave falsa;
> IV — mediante concurso de duas ou mais pessoas.

Fonte oficial: [Código Penal — Planalto](https://www.planalto.gov.br/ccivil_03/decreto-lei/del2848compilado.htm); explicação da qualificadora: [TJDFT — Abuso de confiança](https://www.tjdft.jus.br/institucional/imprensa/campanhas-e-produtos/direito-facil/edicao-semanal/abuso-de-confianca).

A varredura de brainwallets e de chaves geradas com `SecureRandom` fraco pode ser enquadrada nesse núcleo: obter acesso a um bem alheio e transferi-lo para si, explorando uma falha ou uma confiança. A vítima não "abandonou" a carteira; ela apenas não sabe que a chave é fraca. Não há consentimento, não há renúncia e não há "coisa perdida" no sentido de bem sem dono.

### 4.3 Lavagem de dinheiro — Lei 9.613/98

Mover o produto de uma apropriação também pode configurar lavagem:

> **Art. 1º** Ocultar ou dissimular a natureza, origem, localização, disposição, movimentação ou propriedade de bens, direitos ou valores provenientes, direta ou indiretamente, de infração penal.
> Pena — reclusão, de 3 (três) a 10 (dez) anos, e multa.

Fonte oficial: [Lei 9.613/98 — Planalto](https://www.planalto.gov.br/ccivil_03/leis/l9613.htm).

O ponto prático: quem varre uma carteira alheia e depois tenta "limpar" os fundos por exchanges, mixers ou conversões pode responder por furto/apropriação **e** por lavagem. A blockchain é um registro público e permanente; a movimentação fica rastreável mesmo depois de várias transferências.

### 4.4 Marco legal dos criptoativos — Lei 14.478/2022

A Lei 14.478/2022 define ativo virtual e regula prestadoras de serviços de ativos virtuais. A definição legal é ampla:

> **Art. 3º** Para os efeitos desta Lei, considera-se ativo virtual a representação digital de valor que pode ser negociada ou transferida por meios eletrônicos e utilizada para realização de pagamentos ou com propósito de investimento, não incluídos: [...]

Fonte oficial: [Lei 14.478/2022 — Planalto](https://www.planalto.gov.br/ccivil_03/_ato2019-2022/2022/lei/l14478.htm).

A lei organiza o mercado e as prestadoras; ela **não** cria um regime de "finders keepers" nem legaliza a apropriação de ativos de terceiros. Ao contrário: ao reconhecer o ativo virtual como objeto de negócio e de investimento, reforça que ele é um bem com titular.

### 4.5 Dever civil de restituição — Código Civil

O Código Civil também impõe a devolução de coisa alheia perdida e prevê recompensa a quem restitui:

> **Art. 1.233.** Quem quer que ache coisa alheia perdida há de restituí-la ao dono ou legítimo possuidor.
>
> **Art. 1.234.** Aquele que restituir a coisa achada, nos termos do artigo antecedente, terá direito a uma recompensa não inferior a cinco por cento do seu valor, e à indenização pelas despesas que houver feito com a conservação e transporte da coisa, se o dono não preferir abandoná-la.

Fonte oficial: [Código Civil — Planalto](https://www.planalto.gov.br/ccivil_03/leis/2002/l10406compilada.htm).

Ou seja: o ordenamento trata o achado como uma situação que gera **dever de restituição** e, no máximo, direito a recompensa — não como transferência automática de propriedade. Para cripto, a recompensa de 5% é de aplicação duvidosa (não há um "dono" facilmente identificável nem um procedimento claro de entrega), o que reforça a conclusão prudente: não toque; procure o titular ou a autoridade.

### 4.6 Rastreabilidade: o caso Bitfinex

Em 2016, a exchange Bitfinex foi hackeada e perdeu cerca de **119.754 BTC**. Em 2022, o Departamento de Justiça dos EUA anunciou a maior apreensão financeira da história até então, de cerca de **94,6 mil BTC** ligados ao caso ([DOJ — maior apreensão](https://www.justice.gov/archives/opa/pr/justice-department-announces-largest-financial-seizure-and-cryptocurrency-seizure)). Em novembro de 2024, Ilya Lichtenstein foi condenado a cinco anos de prisão e Heather Morgan a 18 meses; em 2025, os EUA pediram a devolução de cerca de 94.643 BTC à exchange ([DOJ — condenação](https://www.justice.gov/usao-dc/pr/couple-sentenced-money-laundering-conspiracy-involving-2016-hacking-cryptocurrency-exchange); [ForkLog — devolução de 94.643 BTC](https://forklog.com/en/us-authorities-to-return-94643-btc-stolen-from-bitfinex/)).

O caso é um lembrete técnico e jurídico: os fundos passaram por mixers, exchanges e conversões, e ainda assim foram rastreados e apreendidos. A ideia de que cripto é "anônima e irrastreável" é falsa para operações em larga escala. Para quem pensa em se apropriar de saldo alheio, o risco de identificação é real.

### 4.7 Conclusão jurídica

- **Não há "coisa achada" de cripto sem consequência.** A analogia com o art. 169, parágrafo único, II, implica dever de restituição e pode configurar crime.
- **Chaves fracas/vazadas podem configurar furto qualificado** (art. 155, § 4º, II), não achado; a movimentação posterior pode ser lavagem (Lei 9.613/98).
- **O Marco Legal dos Criptoativos** (Lei 14.478/2022) reconhece o ativo como bem e regula o mercado; não autoriza apropriação.
- **O Código Civil** impõe restituição e, no máximo, recompensa.
- **A rastreabilidade** torna a impunidade improvável em operações relevantes.
- **A situação do puzzle público** é um caso à parte: o desafio foi criado para ser resolvido, mas este projeto não reivindica o prêmio e não transforma "monitorar" em "tomar". Se você pensa em reivindicar um puzzle, procure orientação jurídica específica; não trate o desafio como autorização para apropriar-se de qualquer saldo parado.

## 5. Por que ferramentas e golpes que prometem "achar carteira abandonada" são fraude

A matemática da seção 3 é a primeira barreira. A segunda é o comportamento:

- **Se o método funcionasse, não seria vendido.** Um agente com capacidade de achar chaves perderia mais tempo e dinheiro tentando vender o "método" do que usando-o. O produto vendido é a esperança, não a capacidade.
- **O roteiro clássico** cobra uma "taxa de ativação", "gás", "desbloqueio" ou "verificação" antes de qualquer resultado; depois pede mais, ou desaparece. Variantes pedem a seed/chave privada "para conferir" — e esvaziam a carteira da vítima.
- **Golpe da recuperação**: quem já perdeu dinheiro é abordado por "advogados", "peritos" ou "agentes" que prometem reaver os fundos mediante pagamento. O FBI alerta para escritórios de advocacia fictícios que visam vítimas de golpes com cripto ([FBI — alerta sobre falsos escritórios de recuperação](https://www.fbi.gov/investigate/cyber/alerts/2024/fictitious-law-firms-targeting-cryptocurrency-scam-victims-offering-to-recover-funds)); o IC3 também registra criminosos se passando pelo próprio FBI/IC3 e prometendo "recuperar" fundos ([IC3 — PSA de 18/04/2025](https://www.ic3.gov/PSA/2025/PSA250418)).
- **O volume é industrial.** O relatório de 2024 do IC3 registra cerca de **US$ 9,3 bilhões** em perdas relacionadas a cripto nos EUA ([IC3 2024 Internet Crime Report](https://www.ic3.gov/AnnualReport/Reports/2024_IC3Report.pdf); cobertura: [CoinDesk](https://www.coindesk.com/markets/2025/04/24/fbi-says-americans-lost-usd9-3b-to-crypto-scams-in-2024)). É um mercado de fraude, não de recuperação.

**Sinais de alerta:** promessa de retorno garantido; cobrança adiantada; pedido de seed/chave; pressa e sigilo; "carteira abandonada" sem endereço verificável; dashboard que mostra saldos que você não pode conferir; Telegram/WhatsApp como único canal; "recuperação" que exige novo depósito. A regra é simples: **nunca compartilhe seed/chave e nunca pague para "liberar" um saldo que não é seu**.

## 6. Alternativas legítimas

1. **Monitoramento passivo de desafios públicos** — é o que este repositório faz: observa endereços públicos, registra mudanças e não reivindica nada. Serve para pesquisa, jornalismo, educação e curiosidade.
2. **Recuperação das próprias carteiras** — seed, backup, dispositivo, senha e suporte do fabricante. Serviços de recuperação podem ser legítimos quando trabalham com material que o dono possui e têm processo verificável; ainda assim, nunca entregue a seed. Guarde-a offline.
3. **Sucessão e backup** — planeje o que acontece com suas chaves: backup redundante, multisig, instruções para herdeiros, cofre físico, testamento e teste de recuperação em vida. Um problema de sucessão mal planejado é uma das formas mais comuns de "perder" cripto para sempre.
4. **Análise de dados públicos** — pesquisa on-chain, auditoria, educação, estudos de fluxo. Nada disso exige chave privada.
5. **Testnet e bug bounty** — experimente em rede de testes e participe de programas de recompensa por falhas; são caminhos legítimos para aprender e até ganhar dinheiro.
6. **Denúncia e devolução** — se você encontrar uma seed/chave que não é sua, a atitude legítima é tentar identificar o dono e devolver, ou procurar a autoridade competente. Isso é o oposto de "achar e ficar".

## 7. O que este repositório entrega

- **[`tools/puzzle-monitor/`](../tools/puzzle-monitor/README.md)**: CLI em Node.js (somente stdlib) que lê endereços públicos, consulta saldo confirmado e número de transações, compara com o snapshot anterior e mostra mudanças, incluindo "endereço esvaziado". Tem modo `--offline` com fixtures, `--help` e testes sem rede. Não gera chaves, não assina e não transmite transações.
- **Este relatório**: o levantamento técnico e jurídico, com fontes verificáveis.
- **README principal**: seção "Ferramentas" apontando para os dois.

O monitor não é uma ferramenta de recuperação. Ele não promete achar nada, não reivindica saldo e não move um satoshi. A utilidade dele é justamente essa: dar visibilidade a um experimento público sem cruzar a linha da apropriação.

## 8. Limitações e riscos

- **Dados mudam.** Saldos e contagens de transações são um retrato de 04/11/2026; doações e gastos alteram tudo.
- **APIs públicas** podem limitar, atrasar ou divergir. O monitor usa saldo confirmado e tem fallback entre duas APIs; ainda assim, o snapshot não é uma auditoria contábil.
- **A lei é interpretativa.** Não há precedente específico sobre "coisa achada" de cripto; a analogia com o art. 169 é a mais próxima, mas não é pacífica. Consulte um advogado para um caso concreto.
- **O puzzle é um caso à parte.** O desafio é público, mas a legalidade de reivindicar o prêmio não é o objeto deste projeto; o monitor não reivindica nada.
- **Sem promessa de retorno.** Nenhuma categoria descrita aqui é um plano de enriquecimento. O custo computacional e o custo jurídico superam, de longe, qualquer ganho esperado.

## 9. O que foi verificado e o que não foi

**Verificado em fonte primária (04/11/2026):**

- os saldos e as contagens de transações foram lidos via `blockstream.info` (API Esplora); a `mempool.space` foi usada como conferência pontual e como API alternativa do monitor; os endereços vieram da transação pública de 2015;
- a transação de 2015 tem 256 saídas P2PKH, de 0,001 a 0,256 BTC, e os 160 endereços de `addresses.json` batem com as 160 primeiras saídas (0 divergências);
- o endereço #71 tem 7,10195986 BTC, 72 transações e zero saídas gastas; os endereços #64 a #70 estão zerados;
- o snapshot dos 160 endereços soma 903,01685753 BTC, com 77 endereços ainda com saldo e 83 zerados;
- o hashrate da rede estava em ≈ 1,01 × 10^21 H/s;
- o endereço de queima `1BitcoinEater…` tinha 13,41880759 BTC e zero gasto;
- os textos legais foram conferidos no Planalto e em páginas do TJDFT; as citações do art. 169, parágrafo único, II, e do art. 155, § 4º, II, estão transcritas acima;
- o site do trustee do Mt. Gox confirma o prazo de 31/10/2027 e os avisos de pagamento em BTC e BCH.

**Não verificado / fora de escopo:**

- datas individuais de resolução de cada puzzle (o critério usado foi on-chain: saldo zerado = já gasto);
- existência de precedente judicial brasileiro específico sobre cripto "achada";
- legalidade, caso a caso, de reivindicar o prêmio de um puzzle público;
- qualquer chave privada, seed ou carteira — nada disso foi acessado, e nada disso deve ser compartilhado com ferramentas de terceiros.

## 10. Fontes

Todas as URLs foram acessadas em 04/11/2026.

1. Bitcoin Wiki — *Technical background of version 1 Bitcoin addresses*: <https://en.bitcoin.it/wiki/Technical_background_of_version_1_Bitcoin_addresses>
2. Bitcoin Wiki — *Secp256k1*: <https://en.bitcoin.it/wiki/Secp256k1>
3. Bitcoin Wiki — *OP_RETURN*: <https://en.bitcoin.it/wiki/OP_RETURN>
4. Bitcoin Wiki — *Testnet*: <https://en.bitcoin.it/wiki/Testnet>
5. Mempool.space — transação de 2015 com as 256 saídas: <https://mempool.space/tx/08389f34c98c606322740c0be6a7125d9860bb8d5cb182c02f98461e5fa6cd15>
6. Mempool.space — endereço do puzzle #71: <https://mempool.space/address/1PWo3JeB9jrGwfHDNpdGK54CRas7fsVzXU>
7. Mempool.space — endereço de queima: <https://mempool.space/address/1BitcoinEaterAddressDontSendf59kuE>
8. Mempool.space — hashrate e dificuldade: <https://mempool.space/graphs/mining/hashrate-difficulty> (API: <https://mempool.space/api/v1/mining/hashrate/3d>)
9. BTC Puzzle — lista e placar dos puzzles: <https://btcpuzzle.info/puzzle>
10. BTC Puzzle Search — puzzle #71: <https://btcpuzzlesearch.com/puzzle/71>
11. BitcoinTalk — pool público do puzzle #71: <https://bitcointalk.org/index.php?topic=5588240.0>
12. JeanLucPons — *Pollard's kangaroo for SECP256K1*: <https://github.com/JeanLucPons/Kangaroo>
13. Bitcoin.org — *Android Security Vulnerability* (11/08/2013): <https://bitcoin.org/en/alert/2013-08-11-android>
14. Android Developers Blog — *Some SecureRandom Thoughts*: <https://android-developers.googleblog.com/2013/08/some-securerandom-thoughts.html>
15. Vasek, Bonneau, Castellucci, Keith e Moore — *The Bitcoin Brain Drain* (FC 2016): <https://jbonneau.com/doc/VBCKM16-FC-bitcoin_brain_wallets.pdf>
16. MTGOX — avisos oficiais do trustee (reembolsos em BTC/BCH; prazo em 31/10/2027): <https://www.mtgox.com/>
17. U.S. Department of Justice — *Justice Department Announces Largest Financial Seizure and Cryptocurrency Seizure*: <https://www.justice.gov/archives/opa/pr/justice-department-announces-largest-financial-seizure-and-cryptocurrency-seizure>
18. U.S. Department of Justice — condenação no caso Bitfinex: <https://www.justice.gov/usao-dc/pr/couple-sentenced-money-laundering-conspiracy-involving-2016-hacking-cryptocurrency-exchange>
19. ForkLog — devolução de 94.643 BTC à Bitfinex: <https://forklog.com/en/us-authorities-to-return-94643-btc-stolen-from-bitfinex/>
20. Código Penal — Planalto: <https://www.planalto.gov.br/ccivil_03/decreto-lei/del2848compilado.htm>
21. Lei 9.613/98 (lavagem) — Planalto: <https://www.planalto.gov.br/ccivil_03/leis/l9613.htm>
22. Lei 14.478/2022 (criptoativos) — Planalto: <https://www.planalto.gov.br/ccivil_03/_ato2019-2022/2022/lei/l14478.htm>
23. Código Civil — Planalto: <https://www.planalto.gov.br/ccivil_03/leis/2002/l10406compilada.htm>
24. TJDFT — *"Achado não é roubado"*: <https://www.tjdft.jus.br/institucional/imprensa/campanhas-e-produtos/direito-facil/edicao-semanal/achado-nao-e-roubado>
25. TJDFT — *Abuso de confiança* (art. 155, § 4º, II): <https://www.tjdft.jus.br/institucional/imprensa/campanhas-e-produtos/direito-facil/edicao-semanal/abuso-de-confianca>
26. FBI — alerta sobre falsos escritórios de recuperação de cripto: <https://www.fbi.gov/investigate/cyber/alerts/2024/fictitious-law-firms-targeting-cryptocurrency-scam-victims-offering-to-recover-funds>
27. IC3 — PSA sobre criminosos se passando pelo FBI/IC3 (18/04/2025): <https://www.ic3.gov/PSA/2025/PSA250418>
28. IC3 — *2024 Internet Crime Report*: <https://www.ic3.gov/AnnualReport/Reports/2024_IC3Report.pdf>
29. CoinDesk — perdas de US$ 9,3 bilhões em golpes com cripto em 2024: <https://www.coindesk.com/markets/2025/04/24/fbi-says-americans-lost-usd9-3b-to-crypto-scams-in-2024>
30. Bitcoin Cash — site oficial do fork: <https://bitcoincash.org/>
31. BIP-39 — seed mnemônica: <https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki>
32. BIP-32 — carteiras hierárquicas determinísticas: <https://github.com/bitcoin/bips/blob/master/bip-0032.mediawiki>
