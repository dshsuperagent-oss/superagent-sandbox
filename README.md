# Torre de Ferro — Defesa do Último Posto

Jogo 3D de **defesa de torre** no navegador, em pt-BR, feito para rodar **sem build e
sem dependências**: `node serve.mjs` servindo a pasta e o jogo abre em
`http://127.0.0.1:8099/`. WebGL via Three.js vendorizado, simulação pura em módulos
ES, áudio 100% sintetizado com WebAudio (zero arquivo de áudio) e efeitos procedurais
(sem imagens/modelos externos).

Também é **instalável como app (PWA)** em **Android e iPad** e tem **controles de toque**
(um dedo gira, pinça dá zoom, toque constrói). Publicado em HTTPS:
**https://dshsuperagent-oss.github.io/superagent-sandbox/**

## Campanha da expansão (issue #20)

A expansão transformou o jogo em uma **campanha de exatamente 20 fases × 2 ondas =
40 ondas**, com progressão de recursos, desbloqueios por fase e save v2:

- **20 fases numeradas 1–20**, cada uma com **2 ondas** (`WAVES_PER_PHASE = 2`).
  A 1ª onda é a preparação; a 2ª é a onda principal da fase.
- **Cenários:** fases **1–7 Deserto**, **8–14 Neve** e **15–20 Cidade**
  (`PHASES_PER_SCENARIO = {deserto: 7, neve: 7, cidade: 6}`).
- **Chefes na 2ª onda das fases 5, 10, 15 e 20:**
  | Fase | Onda | Chefe | Classe |
  |---|---|---|---|
  | 5 | 2 | General de Ferro (`chefe-deserto`) | terrestre |
  | 10 | 2 | Fortaleza Voadora (`chefe-neve`) | **aéreo** |
  | 15 | 2 | General de Ferro (`chefe-deserto`) | terrestre |
  | 20 | 2 | Mecha Titã (`chefe-cidade`) | terrestre/**mecha** |
- **Inimigos aéreos desde a fase 1, onda 2**, em todos os cenários.
- **HUD:** `Fase n/20 · Onda m/2` (onda **local** da fase) e o nome do cenário.
- **Telas:** seleção de missão com as 20 fases agrupadas por cenário
  (Deserto 1–7, Neve 8–14, Cidade 15–20), desbloqueio sequencial (fase n+1 exige n
  concluída), vitória/derrota por fase e **campanha concluída** ao vencer a fase 20.

## Screenshots

Capturas **reais** do jogo rodando em Chromium headless (1280×800 no desktop;
emuladores de iPhone/iPad nos testes de toque), geradas por `tests/browser-check.mjs`
e `tests/mobile-check.mjs`:

| | |
|---|---|
| ![Menu](docs/screenshots/menu.png) | ![Seleção de missão — 20 fases](docs/screenshots/missoes.png) |
| Menu — `menu.png` | Seleção de missão no início (0/20; Deserto 1–7) — `missoes.png` |
| ![Seleção das 20 fases — grupos Neve/Cidade](docs/screenshots/missoes-20-fases.png) | ![Fase com progressão](docs/screenshots/fase-progressao.png) |
| Seleção com as **20/20 fases concluídas** (60/60 estrelas) — `missoes-20-fases.png` | Fase 12 (Neve) com HUD `Fase 12/20 · Onda 2/2` — `fase-progressao.png` |
| ![Painel Construir com desbloqueios](docs/screenshots/kit-construir.png) | ![Batalha com aéreos](docs/screenshots/batalha-aereos.png) |
| Painel Construir na fase 1 com "Desbloqueia na fase N" — `kit-construir.png` | Onda 2 da fase 1 com aéreos — `batalha-aereos.png` |
| ![Onda de chefe](docs/screenshots/chefe-painel.png) | ![Campanha concluída](docs/screenshots/campanha-concluida.png) |
| Onda de chefe (fase 5, 2ª onda) — `chefe-painel.png` | Campanha concluída (fase 20 vencida) — `campanha-concluida.png` |
| ![Vitória](docs/screenshots/vitoria.png) | ![Derrota](docs/screenshots/derrota.png) |
| Vitória da fase 1 — `vitoria.png` | Derrota — `derrota.png` |
| ![iPhone — seleção](docs/screenshots/mobile-iphone-menu.png) | ![iPhone — batalha](docs/screenshots/mobile-iphone-batalha.png) |
| iPhone retrato — menu — `mobile-iphone-menu.png` | iPhone retrato — batalha — `mobile-iphone-batalha.png` |
| ![iPhone — chefe sem cobrir a HUD](docs/screenshots/mobile-iphone-chefe.png) | ![iPad — chefe sem cobrir a HUD](docs/screenshots/mobile-ipad-chefe.png) |
| **BUG-MOB-04 corrigido:** chefe no iPhone, barra abaixo da HUD — `mobile-iphone-chefe.png` | **BUG-MOB-04 corrigido:** chefe no iPad — `mobile-ipad-chefe.png` |

Arquivos individuais: [`menu.png`](docs/screenshots/menu.png) ·
[`missoes.png`](docs/screenshots/missoes.png) ·
[`missoes-20-fases.png`](docs/screenshots/missoes-20-fases.png) ·
[`fase-progressao.png`](docs/screenshots/fase-progressao.png) ·
[`kit-construir.png`](docs/screenshots/kit-construir.png) ·
[`batalha-aereos.png`](docs/screenshots/batalha-aereos.png) ·
[`chefe-painel.png`](docs/screenshots/chefe-painel.png) ·
[`campanha-concluida.png`](docs/screenshots/campanha-concluida.png) ·
[`vitoria.png`](docs/screenshots/vitoria.png) ·
[`derrota.png`](docs/screenshots/derrota.png) ·
[`mobile-iphone-menu.png`](docs/screenshots/mobile-iphone-menu.png) ·
[`mobile-iphone-batalha.png`](docs/screenshots/mobile-iphone-batalha.png) ·
[`mobile-ipad-batalha.png`](docs/screenshots/mobile-ipad-batalha.png) ·
[`mobile-iphone-paisagem-batalha.png`](docs/screenshots/mobile-iphone-paisagem-batalha.png) ·
[`mobile-iphone-chefe.png`](docs/screenshots/mobile-iphone-chefe.png) ·
[`mobile-ipad-chefe.png`](docs/screenshots/mobile-ipad-chefe.png).

## Como rodar

Requisito: **Node.js 18+** (só para o servidor estático; o jogo em si é HTML/JS puro)
e um navegador com WebGL habilitado (Chrome/Edge/Firefox recentes).

```bash
cd games/torre-de-ferro
node serve.mjs          # imprime http://127.0.0.1:8099/ (porta padrão)
node serve.mjs 9000     # porta alternativa: http://127.0.0.1:9000/
```

Abra a URL impressa no navegador. Não há `npm install`, bundler, backend nem
requisição externa: o servidor é Node stdlib (só `http`/`fs`/`path`) e todos os
assets do jogo são arquivos locais ou sintetizados em runtime.

O servidor entrega MIME correto, `Cache-Control: no-store`, `404` para caminho
inexistente e bloqueia tentativas de path traversal (`..`, `%2e%2e`). `/` serve o
`index.html`. Ele também responde `204` em `/favicon.ico` para o Chromium não
registrar um `404` de console.

## No PC (Windows) — instalação com atalho

O instalador (sem administrador) copia o jogo para `F:\Jogos\Torre de Ferro`, cria atalho no
Desktop e no Menu Iniciar e registra a desinstalação em Aplicativos instalados:

```bat
Instalar Torre de Ferro.cmd
```

Depois, abra pelo atalho **Torre de Ferro** (Desktop ou Menu Iniciar). O servidor local sobe
sozinho na porta 8099; a janela minimizada "Torre de Ferro - servidor" mantém o jogo no ar e
pode ser fechada para parar. Para remover: Menu Iniciar → Torre de Ferro → Desinstalar.

## No celular e no tablet (Android/iPad) — PWA

O jogo está publicado em HTTPS: **https://dshsuperagent-oss.github.io/superagent-sandbox/**

- **Android (Chrome):** abra o link → menu ⋮ → **Instalar app** (ou "Adicionar à tela inicial").
- **iPad (Safari):** abra o link → botão **Compartilhar** → **Adicionar à Tela de Início**.
- Depois da primeira visita o jogo abre **offline** (service worker em cache).
- Controles: **um dedo** gira a câmera, **dois dedos** dão pinça (zoom) e deslocam, **toque** em
  um slot constrói e em uma torre abre o painel; há botões **−/+** de zoom na barra superior.
- A **seleção das 20 fases** também é 100% por toque: o painel rola, os cards mostram
  cadeado/estrelas e um toque abre a fase liberada.
- **BUG-MOB-04 corrigido:** na onda de chefe a barra de vida do chefe fica **abaixo da HUD**
  e não intercepta mais os botões (ver seção própria abaixo).

## Controles

| Ação | Controle |
|---|---|
| Orbitar a câmera | arrastar com o botão esquerdo |
| Deslocar (pan) | arrastar com o botão direito |
| Zoom | roda do mouse |
| Construir torre no slot | clique no slot vazio (abre o painel Construir) |
| Abrir painel da torre | clique em uma torre construída |
| Construir pela tecla | `1` metralhadora · `2` antiaéreo · `3` morteiro · `4` tesla · `5` criogênica · `6` míssil |
| Posicionar tropa | `7` fuzileiros · `8` antiaérea · `9` sniper (ou painel Tropas → Posicionar) |
| Melhorar torre | `U` (ou botão Melhorar no painel da torre) |
| Vender torre | `V` (devolve 70% do total investido) |
| Pausar / retomar | `Espaço` (ou botão Pausar / Continuar) |
| Velocidade 1× / 2× | `F` (ou botão 1x/2x) |
| Mudo / som | `M` (ou botão Som) |
| Iniciar a próxima onda | `N` (ou botão Iniciar Onda; a preparação também começa sozinha em 25 s) |
| Ajuda | `H` |
| Fechar painel / voltar | `Esc` |

No celular/tablet: **um dedo** gira · **dois dedos** dão pinça (zoom) e deslocam · **toque** constrói/seleciona · botões **−/+** também dão zoom. Torres/tropas/upgrades ainda bloqueados aparecem **desabilitados** com o texto **"Desbloqueia na fase N"**.

## Campanha de 20 fases — composição das 40 ondas

A issue #20 fecha as **20 fases, 2 ondas por fase, os cenários e os chefes**, mas a
composição das 40 ondas **deriva das 24 ondas da campanha original** (issue #18),
reorganizadas em duas ondas por fase e escaladas ao longo da campanha. Nada foi
inventado: os tipos, grupos e intervalos vêm da tabela anterior; a tabela final é a
de `src/sim/waves.js` (`waveFor(phase, waveInPhase)`).

Grupo = `{ type, count, delay }`: o 1º inimigo do grupo nasce `delay` segundos depois
do início da onda e os demais a cada `SPAWN_INTERVALS[type]`.

| Fase | Cenário | Onda 1 (preparação) | Onda 2 (principal) |
|---|---|---|---|
| 1 | Deserto | `soldado×8` | `soldado×10` · `drone×4` |
| 2 | Deserto | `soldado×10` · `blindado×2` | `soldado×10` · `drone×6` · `blindado×3` |
| 3 | Deserto | `drone×6` · `soldado×6` | `drone×8` · `soldado×8` · `blindado×4` |
| 4 | Deserto | `soldado×10` · `tanque×1` | `soldado×10` · `tanque×2` · `helicoptero×2` |
| 5 | Deserto | `drone×10` · `blindado×5` | **`chefe-deserto` (General de Ferro)** · `tanque×2` · `drone×8` · `helicoptero×2` |
| 6 | Deserto | `soldado×12` · `tanque×2` · `helicoptero×1` | `soldado×12` · `tanque×3` · `helicoptero×3` · `bombardeiro×1` |
| 7 | Deserto | `drone×12` · `blindado×6` · `helicoptero×2` | `drone×12` · `blindado×8` · `helicoptero×4` · `bombardeiro×2` |
| 8 | Neve | `soldado×12` | `soldado×12` · `drone×8` |
| 9 | Neve | `blindado×6` | `blindado×6` · `helicoptero×3` |
| 10 | Neve | `drone×12` · `tanque×1` | **`chefe-neve` (Fortaleza Voadora)** · `zepelim×1` · `drone×10` · `helicoptero×3` |
| 11 | Neve | `soldado×12` · `drone×4` | `soldado×12` · `helicoptero×5` |
| 12 | Neve | `bombardeiro×1` · `blindado×6` | `bombardeiro×2` · `blindado×8` |
| 13 | Neve | `tanque×3` · `helicoptero×2` | `zepelim×1` · `drone×12` · `helicoptero×3` |
| 14 | Neve | `tanque×4` · `bombardeiro×1` | `tanque×4` · `bombardeiro×2` · `helicoptero×4` · `zepelim×1` |
| 15 | Cidade | `soldado×14` · `drone×6` | **`chefe-deserto` (General de Ferro)** · `tanque×2` · `soldado×10` · `drone×8` · `helicoptero×2` |
| 16 | Cidade | `helicoptero×4` · `tanque×2` | `helicoptero×6` · `tanque×3` · `drone×6` |
| 17 | Cidade | `bombardeiro×2` · `drone×10` | `bombardeiro×3` · `drone×14` |
| 18 | Cidade | `zepelim×1` · `blindado×8` | `zepelim×2` · `blindado×10` · `helicoptero×4` |
| 19 | Cidade | `tanque×5` · `bombardeiro×3` | `tanque×6` · `bombardeiro×4` · `zepelim×2` · `helicoptero×6` |
| 20 | Cidade | `tanque×6` · `bombardeiro×4` · `drone×10` | **`chefe-cidade` (Mecha Titã)** · `zepelim×3` · `helicoptero×6` · `tanque×4` · `drone×12` |

## Progressão de recursos

Todas as fórmulas abaixo são exatamente as da issue #20 e estão em `src/sim/data.js`.

### Caixa inicial e bônus permanente

- **Caixa inicial da fase:** `300 + 25 × (fase − 1) + bônusPermanente`
  (`startingMoneyFor(phase, bonusPermanent)`). A caixa **não transporta** entre
  fases — cada fase começa com o valor calculado.
- **Bônus permanente:** `min(250, 25 × fasesConcluídas)` (`bonusPermanentFor`).
  Acumula ao vencer fases e **nunca regride** (o save guarda o maior valor entre o
  salvo e o derivado).
- **Vidas:** 20 por fase (reset a cada fase).

| Fase | Caixa sem bônus | Bônus permanente máx. | Caixa máx. |
|---|---|---|---|
| 1 | $300 | +$0 | $300 |
| 2 | $325 | +$25 | $350 |
| 3 | $350 | +$50 | $400 |
| 4 | $375 | +$75 | $450 |
| 5 | $400 | +$100 | $500 |
| 6 | $425 | +$125 | $550 |
| 7 | $450 | +$150 | $600 |
| 8 | $475 | +$175 | $650 |
| 9 | $500 | +$200 | $700 |
| 10 | $525 | +$225 | $750 |
| 11 | $550 | +$250 | $800 |
| 12 | $575 | +$250 | $825 |
| 13 | $600 | +$250 | $850 |
| 14 | $625 | +$250 | $875 |
| 15 | $650 | +$250 | $900 |
| 16 | $675 | +$250 | $925 |
| 17 | $700 | +$250 | $950 |
| 18 | $725 | +$250 | $975 |
| 19 | $750 | +$250 | $1000 |
| 20 | $775 | +$250 | $1025 |

(O "bônus permanente máx." assume todas as fases anteriores concluídas; com menos
fases concluídas o bônus é proporcional.)

### Recompensa por abate (tabela final por fase)

- **Recompensa por abate da fase:** `round(valorBase × (1 + 0,05 × (fase − 1)))`
  (`rewardFor(def.reward, phase)`). `valorBase` é o valor final da tabela `ENEMIES`
  (que já inclui o balanceamento da issue #18: HP ×0,84 e recompensa ×1,15).
- A recompensa cai na caixa **na hora** do abate.

Inimigos comuns (`$` por abate):

| Fase | Soldado | Blindado | Tanque | Drone | Helicóptero | Bombardeiro | Zepelim |
|---|---|---|---|---|---|---|---|
| 1 | $9 | $21 | $52 | $12 | $35 | $81 | $173 |
| 2 | $9 | $22 | $55 | $13 | $37 | $85 | $182 |
| 3 | $10 | $23 | $57 | $13 | $39 | $89 | $190 |
| 4 | $10 | $24 | $60 | $14 | $40 | $93 | $199 |
| 5 | $11 | $25 | $62 | $14 | $42 | $97 | $208 |
| 6 | $11 | $26 | $65 | $15 | $44 | $101 | $216 |
| 7 | $12 | $27 | $68 | $16 | $46 | $105 | $225 |
| 8 | $12 | $28 | $70 | $16 | $47 | $109 | $234 |
| 9 | $13 | $29 | $73 | $17 | $49 | $113 | $242 |
| 10 | $13 | $30 | $75 | $17 | $51 | $117 | $251 |
| 11 | $14 | $32 | $78 | $18 | $53 | $122 | $260 |
| 12 | $14 | $33 | $81 | $19 | $54 | $126 | $268 |
| 13 | $14 | $34 | $83 | $19 | $56 | $130 | $277 |
| 14 | $15 | $35 | $86 | $20 | $58 | $134 | $285 |
| 15 | $15 | $36 | $88 | $20 | $60 | $138 | $294 |
| 16 | $16 | $37 | $91 | $21 | $61 | $142 | $303 |
| 17 | $16 | $38 | $94 | $22 | $63 | $146 | $311 |
| 18 | $17 | $39 | $96 | $22 | $65 | $150 | $320 |
| 19 | $17 | $40 | $99 | $23 | $67 | $154 | $329 |
| 20 | $18 | $41 | $101 | $23 | $68 | $158 | $337 |

Chefes (`$` por abate; só aparecem nas fases 5/10/15/20, mas o valor por fase segue a
fórmula):

| Fase | General de Ferro | Fortaleza Voadora | Mecha Titã |
|---|---|---|---|
| 1 | $460 | $1035 | $2300 |
| 2 | $483 | $1087 | $2415 |
| 3 | $506 | $1139 | $2530 |
| 4 | $529 | $1190 | $2645 |
| 5 | $552 | $1242 | $2760 |
| 6 | $575 | $1294 | $2875 |
| 7 | $598 | $1346 | $2990 |
| 8 | $621 | $1397 | $3105 |
| 9 | $644 | $1449 | $3220 |
| 10 | $667 | $1501 | $3335 |
| 11 | $690 | $1553 | $3450 |
| 12 | $713 | $1604 | $3565 |
| 13 | $736 | $1656 | $3680 |
| 14 | $759 | $1708 | $3795 |
| 15 | $782 | $1760 | $3910 |
| 16 | $805 | $1811 | $4025 |
| 17 | $828 | $1863 | $4140 |
| 18 | $851 | $1915 | $4255 |
| 19 | $874 | $1967 | $4370 |
| 20 | $897 | $2018 | $4485 |

### Bônus por onda

- **Bônus ao concluir uma onda:** `25 + 10 × ondaGlobal`, com `ondaGlobal =
  (fase − 1) × 2 + ondaLocal` (1..40) — `waveBonus(globalWave)`.
  O bônus é creditado quando a fila de spawn esvazia e não há inimigo vivo.

| Fase | Onda 1 (global) | Bônus | Onda 2 (global) | Bônus |
|---|---|---|---|---|
| 1 | 1 | $35 | 2 | $45 |
| 2 | 3 | $55 | 4 | $65 |
| 3 | 5 | $75 | 6 | $85 |
| 4 | 7 | $95 | 8 | $105 |
| 5 | 9 | $115 | 10 | $125 |
| 6 | 11 | $135 | 12 | $145 |
| 7 | 13 | $155 | 14 | $165 |
| 8 | 15 | $175 | 16 | $185 |
| 9 | 17 | $195 | 18 | $205 |
| 10 | 19 | $215 | 20 | $225 |
| 11 | 21 | $235 | 22 | $245 |
| 12 | 23 | $255 | 24 | $265 |
| 13 | 25 | $275 | 26 | $285 |
| 14 | 27 | $295 | 28 | $305 |
| 15 | 29 | $315 | 30 | $325 |
| 16 | 31 | $335 | 32 | $345 |
| 17 | 33 | $355 | 34 | $365 |
| 18 | 35 | $375 | 36 | $385 |
| 19 | 37 | $395 | 38 | $405 |
| 20 | 39 | $415 | 40 | $425 |

### Vidas e estrelas

20 vidas por fase. Estrelas ao vencer: **3 = 20 vidas, 2 = 14–19, 1 = 1–13**
(0 = derrota); `starsForLives`. O save guarda `stars` e `bestLives` por fase
(melhor resultado; nunca piora).

## Desbloqueios por fase

Torres, tropas e upgrades são liberados pela fase da campanha; fora da fase de
desbloqueio o botão/card fica **desabilitado** com o texto **"Desbloqueia na fase N"**.
O engine também bloqueia por API (`{ok:false, error:'bloqueado', unlockPhase:N}`).

### Torres (`TOWER_UNLOCK_PHASE`)

| Fase | Torres liberadas |
|---|---|
| 1 | Metralhadora, Morteiro |
| 2 | + Antiaéreo |
| 4 | + Tesla |
| 6 | + Criogênica |
| 8 | + Míssil |

### Tropas (`TROOP_UNLOCK_PHASE`)

| Fase | Tropa liberada |
|---|---|
| 1 | Esquadrão de Fuzileiros |
| 3 | + Equipe Antiaérea |
| 5 | + Sniper de Elite |

### Upgrades (`UPGRADE_UNLOCK_PHASE`)

| Nível da torre | Fase mínima |
|---|---|
| Nível 2 | 2 |
| Nível 3 | 5 |

Antes da fase de desbloqueio o botão **Melhorar** mostra `Desbloqueia na fase N` e
fica desabilitado; a API responde `{ok:false, error:'bloqueado', level, unlockPhase}`.

## Save v2 (e migração do v1)

Chave **`td3d:save:v2`** no `localStorage` (a antiga `td3d:save:v1` é lida e migrada;
ela **permanece como backup**). Schema exato:

```js
{
  version: 2,
  tutorialDone: false,
  settings: { volume: 0.7, muted: false, speed: 1 },
  bonusPermanent: 0,                    // min(250, 25 × fases concluídas), nunca regride
  phases: [ { completed: false, stars: 0, bestLives: 0 } × 20 ], // índice = fase-1
  totals: { kills: 0, waves: 0, timePlayed: 0 }
}
```

Regras de `validateSave` (aplicadas no boot, em `src/sim/data.js`):

- sanitiza/limita **tudo** (volume 0–1, estrelas 0–3, fases 1..20, `bestLives`
  coerente com as estrelas);
- exige **progressão sequencial**: a fase n só pode estar concluída se 1..n−1
  estiverem; progresso inválido/lixo após o primeiro buraco é descartado;
- recalcula `bonusPermanent` (nunca menor que o derivado, teto 250);
- **não existe save no meio da partida** — só progresso entre partidas.

**Migração v1 → v2** (`migrateSaveV1`, chamada por `validateSave`; `main.js` grava a v2
no boot quando só existe a v1):

```
Entrada v1: {version:1, tutorialDone, settings, maps:{deserto|neve|cidade:{unlocked,stars,wavesWon,bestLives}}, totals}
Por cenário:  concluídasNoCenário = floor(wavesWon / 8 × fasesDoCenário)   // fasesDoCenário = 7/7/6
              wavesWon = 8  ⇒ todas as fases do cenário concluídas com as estrelas antigas
              parcial       ⇒ fases derivadas concluídas com 1 estrela (sem inventar notas altas)
Mantém tutorialDone, settings e totals; bonusPermanent derivado das fases concluídas.
```

## Conteúdo do jogo

**Inimigos.** Valores base finais (já com o balanceamento da issue #18: HP base ×0,84 e
recompensa ×1,15). O HP **escala com a onda global** (1..40):
`round(HP × (1 + HP_SCALE × (ondaGlobal − 1)))`, com `HP_SCALE = 0,03` (ver
"Balancete da expansão"). Dano, velocidade e recompensa base não escalam.

| Inimigo | Classe | HP base | HP na onda 40 | Vel. (u/s) | Dano à base | Recompensa base |
|---|---|---|---|---|---|---|
| Soldado | terrestre | 50 | 109 | 3,2 | 1 | $9 |
| Blindado | terrestre | 168 | 365 | 2,2 | 1 | $21 |
| Tanque | terrestre | 546 | 1185 | 1,6 | 2 | $52 |
| Drone | **aéreo** | 38 | 82 | 4,0 | 1 | $12 |
| Helicóptero | **aéreo** | 210 | 456 | 3,0 | 1 | $35 |
| Bombardeiro | **aéreo** | 672 | 1458 | 1,8 | 2 | $81 |
| Zepelim | **aéreo** | 1512 | 3281 | 0,9 | 5 | $173 |
| General de Ferro | chefe terrestre | 3360 | 7291 | 1,4 | 10 | $460 |
| Fortaleza Voadora | **chefe aéreo** | 5880 | 12760 | 0,8 | 10 | $1035 |
| Mecha Titã | chefe terrestre | 10080 | 21874 | 1,1 | 10 | $2300 |

Chefes têm 50% de resistência a lentidão, não são bloqueados por tropas e atacam
tropas em um raio de 2,5 u.

**Torres** (custo L1/L2/L3; dano/cadência/alcance por nível):

| Torre | Alvo | Custo | Dano | Cadência (s) | Alcance | Efeito |
|---|---|---|---|---|---|---|
| Metralhadora | terrestre | 100/80/140 | 12/22/36 | 0,60/0,50/0,40 | 14/15/16 | instantâneo |
| Antiaéreo | aéreo | 140/110/180 | 30/55/90 | 1,00/0,90/0,75 | 18/19/20 | instantâneo |
| Morteiro | terrestre | 130/100/160 | 45/80/140 | 1,80/1,60/1,40 | 16/17/18 | splash 4,0/4,5/5,0 u |
| Tesla | terrestre+aéreo | 160/130/190 | 28/46/74 | 1,20/1,10/0,95 | 12/12/13 | cadeia 2/3/4, salto ≤ 6 u, ×0,7 por salto |
| Criogênica | terrestre+aéreo | 110/90/130 | 6/10/16 | 0,80/0,80/0,80 | 13/14/16 | lentidão 25/35/45% por 1,5/2,0/2,5 s (teto 60%) |
| Míssil | terrestre+aéreo | 180/150/220 | 70/120/210 | 2,60/2,40/2,20 | 22/23/24 | teleguiado 14 u/s, splash 3 u ao explodir |

Venda devolve 70% do investido e libera o slot; construir durante a onda é
permitido. Alvo = inimigo compatível no alcance com maior progresso (empate: menor id).

**Tropas especiais** (máximo 1 de cada tipo viva por vez):

| Tropa | Custo | HP | Alcance | Dano | Intervalo | Alvo | Vida útil | Recarga |
|---|---|---|---|---|---|---|---|---|
| Esquadrão de Fuzileiros | $90 | 500 | 8 | 10 | 0,60 s | terrestre | 40 s | 45 s |
| Equipe Antiaérea | $70 | 300 | 16 | 22 | 0,80 s | aéreo | 35 s | 40 s |
| Sniper de Elite | $110 | 250 | 30 | 150 | 2,50 s | terrestre+aéreo | 30 s | 35 s |

Fuzileiros bloqueiam até 4 terrestres num raio de 2,0 u; o sniper prioriza o
inimigo com maior HP e as demais tropas o de maior progresso.

**Áudio e efeitos.** WebAudio 100% sintetizado (tiros, impactos, inimigos, UI e uma
trilha de 8 compassos a 96 BPM com camada extra no chefe), sem nenhum arquivo de
áudio. O `AudioContext` só é criado no primeiro gesto (clique/tecla). Efeitos
procedurais em Three.js: explosões, rastro de míssil, flashes com point lights
limitadas, dano flutuante, hit flash, cadeia tesla, tinta/gelo de lentidão, screen
shake e clima por cenário (areia, neve, brasas).

## Interface e HUD da expansão

- **Menu:** "20 fases, 3 cenários, 40 ondas" e rodapé "20 fases · 3 cenários ·
  40 ondas · 6 torres · 3 tropas especiais".
- **Selecionar Missão** (`#screen-maps`): título "Selecionar Missão", dica "Complete
  uma fase para liberar a próxima…" e `#map-progresso` com
  `X/20 fases concluídas · Y/60 estrelas`. `#map-list` gera **20 `.fase-card`**
  agrupados em 3 `section.fase-grupo[data-cenario]` (Deserto/Neve/Cidade), cada card
  com número, cenário, estrelas e estado ("Disponível", "Concluída · melhor: N
  vidas" ou "Bloqueada" + cadeado). O avanço é **sequencial** (fase n+1 exige n).
- **HUD da partida:** `#hud-onda` = **`Fase n/20 · Onda m/2`**; cenário em
  `#hud-mapa`; caixa e vidas em `#hud-dinheiro`/`#hud-vidas`.
- **Painéis:** no Construir, cards bloqueados têm `.torre-card--bloqueada` e
  `.torre-bloqueio` com "Desbloqueia na fase N"; no painel da torre,
  `#btn-melhorar` fica desabilitado com "Desbloqueia na fase N" antes do nível
  liberado; no painel Tropas, cards bloqueados têm `.tropa-card--bloqueada` e
  `.tropa-bloqueio` com o mesmo texto.
- **Fim de fase:** vitória (`#screen-victory`, com vidas/estrelas/`Próxima missão`)
  e derrota (`#screen-defeat`) por fase. **Próxima missão** inicia a fase seguinte e,
  ao vencer a **fase 20**, abre a tela **`#screen-campanha`** ("Campanha concluída!",
  fases concluídas, estrelas totais `X/60`, botões "Selecionar missão" e "Menu").
- **Ajuda/Tutorial** atualizados: 20 fases, chefes nas fases 5/10/15/20, desbloqueios
  por fase e controles de toque.

## Correção do bug mobile BUG-MOB-04

**Bug encontrado pelo QA:** em toque (iPhone retrato e iPad), a barra de vida do chefe
(`.chefe-barra`) cobria a 2ª linha da HUD e **interceptava os botões** — no iPhone
390×844 os botões Velocidade/Pausar/Mudo/Ajuda e no iPad 1024×768
Iniciar Onda/Tropas/Zoom/1x não respondiam durante a onda de chefe.

**Correção em `styles.css`** (sem esconder a barra, que continua visível com a vida do
chefe):

- **`.chefe-barra { pointer-events: none; }` sempre** — a barra nunca captura toque/clique;
- em **`@media (pointer: coarse)`** a barra é posicionada **abaixo da HUD**:
  `top: calc(8.7rem + env(safe-area-inset-top, 0px))` (+ `9.4rem` em retrato estreito
  e `5.6rem` em iPhone paisagem), com regras no fim da folha para vencer as media
  queries anteriores.

**Prova automatizada em `tests/mobile-check.mjs`** (onda 2 da fase 5, chefe real):
`.chefe-barra` com `pointer-events: none`; retângulo **abaixo de todos os `.hud-botoes
.botao`** (iPhone: barra `top=172` vs HUD `bottom=162`, folga de 10 px; iPad: `109` vs
`98,6`, folga de 10,4 px); **hit-test de todos os 8 botões visíveis** pelo
`document.elementFromPoint` no centro (8/8 acertam o próprio botão); e **tocar Pausar e
Ajuda funciona** durante a onda de chefe. Screenshots: `mobile-iphone-chefe.png` e
`mobile-ipad-chefe.png`.

## Evidência antes/depois (BUG-MOB-04 e 20 fases)

Todas as imagens são **capturas reais** do jogo rodando em Chromium (nada de mockup):
o "antes" foi capturado do jogo na versão anterior (campanha de 3 mapas × 8 ondas);
o "depois" sai dos testes desta versão.

| Antes (campanha antiga / bug) | Depois (expansão / corrigido) |
|---|---|
| ![Antes — seleção de 3 mapas](docs/screenshots/antes-selecao-missao.png)<br>`antes-selecao-missao.png` — 3 mapas × 8 ondas | ![Depois — 20 fases](docs/screenshots/missoes-20-fases.png)<br>`missoes-20-fases.png` — 20 fases, 20/20 concluídas |
| ![Antes — HUD "Onda 1/8"](docs/screenshots/antes-hud-onda.png)<br>`antes-hud-onda.png` — HUD antiga `Onda 1/8` | ![Depois — HUD "Fase 12/20 · Onda 2/2"](docs/screenshots/fase-progressao.png)<br>`fase-progressao.png` — HUD `Fase n/20 · Onda m/2` |
| ![Antes — chefe no iPhone cobrindo a HUD](docs/screenshots/antes-chefe-iphone.png)<br>`antes-chefe-iphone.png` — barra do chefe sobre a HUD (iPhone) | ![Depois — chefe no iPhone abaixo da HUD](docs/screenshots/mobile-iphone-chefe.png)<br>`mobile-iphone-chefe.png` — barra abaixo da HUD |
| ![Antes — chefe no iPad cobrindo a HUD](docs/screenshots/antes-chefe-ipad.png)<br>`antes-chefe-ipad.png` — barra sobre a 2ª linha (iPad) | ![Depois — chefe no iPad abaixo da HUD](docs/screenshots/mobile-ipad-chefe.png)<br>`mobile-ipad-chefe.png` — barra abaixo da HUD |

## Estrutura

```
games/torre-de-ferro/
├── index.html              # telas (menu, missões, partida, pausa, vitória, derrota, campanha, ajuda, controles)
├── styles.css              # tema escuro, HUD, seleção de 20 fases e correção BUG-MOB-04
├── package.json            # type module, scripts; ZERO dependências
├── serve.mjs               # servidor HTTP estático (Node stdlib; 127.0.0.1:8099)
├── manifest.webmanifest    # PWA: nome, ícones, display standalone
├── sw.js                   # service worker: cache offline após a 1ª visita
├── icons/                  # PNGs 192/512 (any + maskable), apple-touch, favicon e .ico
├── README.md               # este arquivo
├── src/
│   ├── main.js             # boot, loop, telas, save v2/migração, handlers da HUD e window.__TD__ (QA)
│   ├── sim/                # simulação pura: sem DOM, Three ou áudio
│   │   ├── rng.js          # mulberry32(20261109) — determinismo
│   │   ├── data.js         # 20 fases, progressão, desbloqueios, save v2 e migração v1
│   │   ├── maps.js         # 3 cenários: waypoints, slots, pontos de tropa, pathPointAt
│   │   ├── waves.js        # as 40 ondas (20 fases × 2), chefes 5/10/15/20
│   │   ├── combat.js       # alvo/tiro/splash/cadeia/lentidão/míssil
│   │   ├── troops.js       # tropas, bloqueio, vida útil e recarga
│   │   └── engine.js       # passo fixo 1/60 s, fase/onda, desbloqueios, economia, vitória/derrota
│   └── render/             # tudo o que toca DOM/Three/WebAudio
│       ├── scene.js        # cena, câmera, picking, clima, update/render, perf()
│       ├── meshes.js       # modelos procedurais (inimigos, torres, tropas, terreno)
│       ├── fx.js           # partículas/efeitos a partir dos eventos
│       ├── hud.js          # telas, HUD, seleção de 20 fases, painéis, tutorial, toasts (só DOM)
│       └── audio.js        # WebAudio sintetizado (sem arquivos)
├── src/vendor/three/       # three.module.js (0.160.0) + LICENSE (MIT)
├── tests/
│   ├── simulate.mjs        # simulação headless + bot de referência das 20 fases + save v2
│   ├── static-check.mjs    # checagens estáticas + serve.mjs (HTTP 200/404, MIME, no-store)
│   ├── browser-check.mjs   # Chromium headless: joga via __TD__, valida UI/save/migração, captura screenshots
│   └── mobile-check.mjs    # iPhone/iPad/paisagem: toque, 20 fases, BUG-MOB-04 (chefe), PWA e offline
└── docs/screenshots/       # capturas reais (desktop, iPhone/iPad, chefe e antes/depois)
```

**Arquitetura em uma frase:** `src/sim/` é pura e determinística, avança em passos
fixos de 1/60 s e emite uma fila de eventos; `src/main.js` consome essa fila
distribuindo para `render/scene.js` (visual), `render/fx.js` (partículas),
`render/audio.js` (som) e `render/hud.js` (DOM), sem que render/HUD chamem a
simulação diretamente.

## Testes

Rode em `games/torre-de-ferro/` (Node 18+):

```bash
node tests/simulate.mjs             # < 10 s — 20 fases × 2 ondas, composição, chefes, progressão,
                                    # desbloqueios, save v2/migração, vitória/derrota/estrelas e
                                    # bot de referência vencendo as 20 fases
node tests/simulate.mjs --completo  # bot vence as 20 fases com vidas ≥ 8 em cada fase
node tests/static-check.mjs         # arquitetura, zero URL externa/mídia, imports, node --check,
                                    # pt-BR, __TD__ v2, serve.mjs (200/404/MIME/no-store/traversal),
                                    # sem node_modules e nenhum arquivo alterado fora do escopo
node serve.mjs                      # imprime http://127.0.0.1:8099/ e responde 200
node tests/browser-check.mjs        # Chromium 1280×800: __TD__ v2, seleção das 20 fases, HUD
                                    # "Fase n/20 · Onda m/2", desbloqueios, save v2, migração v1→v2,
                                    # joga fase, aéreos, chefe, campanha concluída, 0 console error,
                                    # 0 request externo, WebGL, screenshots
node tests/mobile-check.mjs         # iPhone 390×844, iPad 1024×768 e iPhone paisagem 667×375:
                                    # menu/tutorial/HUD por toque, seleção das 20 fases, painéis,
                                    # velocidade, mudo, zoom, pinça, construção por toque, ONDA DE
                                    # CHEFE sem cobrir a HUD (BUG-MOB-04), manifest+SW e offline
```

Resultados medidos neste ambiente (`NODE_PATH=/root/qa-work/node_modules
CHROMIUM_PATH=/root/.cache/ms-playwright/chromium-1134/chrome-linux/chrome`):

| Teste | Resultado |
|---|---|
| `node tests/simulate.mjs` | **60/60 PASS**, exit 0 (~0,8 s) |
| `node tests/simulate.mjs --completo` | **61/61 PASS**, exit 0 (~0,8 s) |
| `node tests/static-check.mjs` | **19/19 PASS**, exit 0 |
| `node tests/browser-check.mjs` | **32/32 PASS**, exit 0 (10 screenshots 1280×800) |
| `node tests/mobile-check.mjs` | **124/124 PASS**, exit 0 (3 dispositivos + screenshots de chefe) |

O bot de referência vence as **20/20 fases**, sem vender torres, com vidas por fase:

```
[16, 20, 20, 20, 10, 20, 20, 18, 20, 10, 20, 20, 20, 16, 10, 20, 20, 20, 16, 18]
```

Mínimo **10 vidas** (fases 5/10/15, ondas de chefe) — o critério do `--completo` é
**vidas ≥ 8 em cada fase** e foi cumprido em todas as 20.

Sem Playwright, `mobile-check`/`browser-check` imprimem `SKIP` e saem com 0. O
`static-check.mjs` sobe o `serve.mjs` de verdade numa porta livre e confere `200` em
`/`, `/index.html`, `/styles.css`, `/src/main.js` e no Three.js vendorizado, `404` em
`/nao-existe`, `Cache-Control: no-store` e bloqueio de path traversal.

## Origem e versão do Three.js

- **Versão:** three.js **0.160.0** (`REVISION = '160'`), vendorizado em
  `src/vendor/three/three.module.js` (1,21 MiB) + `src/vendor/three/LICENSE` (MIT).
- **Origem:** `https://unpkg.com/three@0.160.0/build/three.module.js`, baixado **uma
  única vez em ambiente de desenvolvimento em 09/11/2026** e versionado no repo.
- **SHA-256** do `three.module.js` vendorizado:
  `76dea8151bc9352aef3528b4262e249b2604f62543828328db978d060d61a495`.
- **Runtime sem requisição externa:** nenhum CDN, nenhuma URL `http(s)` no
  `index.html` ou em `src/` fora do vendor; o harness verifica isso.

## Limitações honestas

- **Sem save no meio da partida:** o `localStorage` guarda só progresso entre
  partidas (fases concluídas, estrelas, bônus permanente, tutorial, ajustes) — sair
  no meio perde a partida.
- **A composição das 40 ondas não vem fechada na issue #20:** ela deriva das 24
  ondas da campanha original (issue #18) reorganizadas em 2 ondas por fase; a tabela
  final está documentada acima e em `src/sim/waves.js`. O único ajuste de
  balanceamento é a curva de HP (ver "Balancete da expansão").
- **Som não auditável em headless:** o harness valida o grafo de áudio e o
  `audioLog`, mas em Chromium headless (e em máquina sem dispositivo de áudio) não
  há som audível para um humano. A trilha/efeitos existem e tocam em navegador normal.
- **`/favicon.ico` responde 204 (exceção intencional ao 404):** o Chromium pede o
  favicon sozinho e um 404 gerava `console.error`; o critério de aceite exige zero
  erro de console. Não é asset do jogo nem toca em arquivo existente.
- **Tutorial só na fase 1:** os 6 passos aparecem apenas na primeira partida da fase 1,
  enquanto `tutorialDone` for falso.
- **Depende de WebGL:** sem WebGL o jogo mostra um aviso legível em vez da cena 3D.
- **Screenshots geradas em headless com SwiftShader:** cores/iluminação podem variar
  levemente em GPU real; as imagens são capturas reais, não montagens.
- **`browser-check.mjs`/`mobile-check.mjs` dependem de Playwright externo:** ele não
  está no repo (sem dependências); sem Playwright o teste é `SKIP` e sai com 0.
- **Sem backend, multijogador, telemetria ou pós-processamento (bloom):** por
  design do escopo — o jogo é estático e, após a primeira visita, funciona **offline**
  graças ao service worker.
- **App nativo não incluso:** a instalação em Android/iPad é via **PWA** (HTTPS +
  "Adicionar à tela inicial"); não há APK/IPA assinado nem publicação em loja. A
  validação móvel foi feita com **emulação Chromium de iPhone/iPad**; recomenda-se um
  teste final em aparelho físico (especialmente Safari no iPad) antes de divulgar.
- **Sem vibração/gestos avançados:** o toque cobre girar, pinça/zoom, construir,
  melhorar/vender e os botões da HUD; não há controles por inclinação do aparelho.

## Balancete da expansão (issue #20)

A issue #20 é **fechada** em fases/cenários/chefes/fórmulas, mas **não define a
composição das 40 ondas**: ela deriva das 24 ondas da issue #18, reorganizadas em
2 ondas por fase e escaladas por fase (tabela em `src/sim/waves.js`). O **único
ajuste de balanceamento** da expansão é a **curva de HP**:

| Item | Campanha antiga (issue #18) | Expansão (issue #20) |
|---|---|---|
| Fórmula de HP | `round(HP × (1 + 0,18 × (onda − 1)))` | `round(HP × (1 + 0,03 × (ondaGlobal − 1)))` |
| Escala | `HP_SCALE = 0,18`, ondas 1–24 | **`HP_SCALE = 0,03`**, ondas globais 1–40 |
| HP na última onda | ×5,14 (onda 24) | ×2,17 (onda 40) |

**Motivo real (medido):** cada fase **reseta a caixa** pela fórmula da issue
(`300 + 25 × (fase − 1) + bônusPermanente`, no máximo **$1025** na fase 20), então o
orçamento por fase é muito menor que o acumulado dos 3 mapas antigos. Com a escala de
0,18 o bot de referência caía nas fases **19/20** (0 vidas); com 0,03 ele vence as
20 fases com mínimo de **10 vidas** (as fases de chefe 5/10/15 puxam o mínimo).

**Mantidos exatamente como na issue:** composição das 40 ondas (derivada das 24
originais), recompensas finais da tabela `ENEMIES` (×1,15 da issue #18) com o
multiplicador por fase ×`(1 + 0,05 × (fase − 1))`, bônus por onda `25 + 10 ×
ondaGlobal`, caixa inicial/bônus permanente, vidas (20), estrelas (20/14–19/1–13),
custos/dano/cadência/alcance das torres, tropas e desbloqueios por fase. **Nenhum
outro número foi alterado.**

## API de QA (`window.__TD__`)

Página de jogo expõe uma API para testes automatizados e depuração no console
(versão **2.0.0**):

```js
start({phase, seed, money, lives, bonusPermanent, completedPhases}), startPhase(phase),
save(), state(), eventLog(n), spawnWave(1|2), spawnEnemy(type,count),
giveMoney(v), setLives(v), setSpeed(1|2), pause(), resume(), fastForward(s),
buildTower(slot,type), upgradeTower(id), sellTower(id), deployTroop(type,point),
audioLog(n), fxLog(n), perf(), zoomBy(fator), view(), projectSlot(i), win(), lose()
```

Campos de metadados (somente leitura): `version` (`"2.0.0"`), `ready` (boolean),
`phases` (**20**), `scenarios` (`['deserto','neve','cidade']`), `enemyTypes` (10),
`towerTypes` (6) e `troopTypes` (3). Os testes esperam
`window.__TD__.ready === true` e validam os campos antes do fluxo.

`state()` devolve um snapshot serializável (JSON) com fase da campanha
(`phaseNumber`, `totalPhases`, `scenario`, `scenarioName`), onda local (`wave`,
`wavesPerPhase`) e global (`globalWave`), `bonusPermanent`, `startingMoney`,
`unlocks` (torres/tropas/upgrades), economia, inimigos, torres, tropas, projéteis,
slots, pontos de tropa, estatísticas, `boss` e a fase da partida
(`prep`/`wave`/`victory`/`defeat`).
