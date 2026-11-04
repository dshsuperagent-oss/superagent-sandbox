#!/usr/bin/env node
'use strict';

/**
 * Monitor passivo de endereços públicos de puzzles Bitcoin.
 *
 * SOMENTE LEITURA. Este programa:
 *   - lê uma lista de endereços públicos de um JSON local;
 *   - consulta saldo confirmado e número de transações em uma API pública
 *     (mempool.space ou blockstream.info), ou fixtures locais com --offline;
 *   - compara com o snapshot anterior e imprime o que mudou;
 *   - grava o novo snapshot em state.json.
 *
 * Ele NÃO gera chaves, NÃO assina, NÃO transmite transações e NÃO acessa
 * carteiras. Não há nada aqui capaz de mover fundos.
 *
 * Requisito: Node.js 18+ (fetch global). Sem dependências externas.
 */

const fs = require('node:fs');
const path = require('node:path');

const VERSION = '1.0.0';
const SCRIPT_DIR = __dirname;

const APIS = {
  mempool: {
    label: 'mempool.space',
    base: 'https://mempool.space/api',
  },
  blockstream: {
    label: 'blockstream.info',
    base: 'https://blockstream.info/api',
  },
};

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_NETWORK = 2;

// Enderecos Base58 (P2PKH/P2SH) e bech32 (segwit), sem validar checksum.
const ADDRESS_RE = /^(?:[13][1-9A-HJ-NP-Za-km-z]{25,34}|bc1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{11,71})$/;

function usage() {
  return `Monitor passivo de puzzles Bitcoin (somente leitura) v${VERSION}

Uso:
  node cli.js [opções]

Opções:
  --addresses <arquivo>  Lista de endereços em JSON (padrão: addresses.json)
  --state <arquivo>      Snapshot anterior/novo (padrão: state.json)
  --api <nome>           blockstream (padrão) ou mempool
  --offline              Não usa a rede: lê fixtures/<endereço>.json
                          (sem --addresses, usa fixtures/addresses.json)
  --fixtures <dir>       Diretório das fixtures (padrão: fixtures)
  --delay <ms>           Intervalo entre consultas (padrão: 150)
  --timeout <ms>         Timeout de cada consulta (padrão: 15000)
  --dry-run              Não grava o novo snapshot
  --version              Mostra a versão e sai
  -h, --help             Mostra esta ajuda e sai

Exemplos:
  node cli.js --help
  node cli.js
  node cli.js --offline --addresses fixtures/addresses.json \\
              --state /tmp/puzzle-state.json
  node cli.js --api mempool --dry-run

O que ele faz:
  1. consulta chain_stats de cada endereço (saldo confirmado e txs);
  2. compara com o snapshot anterior;
  3. imprime saldo, variação, txs, "endereço esvaziado" e endereços novos;
  4. grava o snapshot atualizado (salvo com --dry-run).

Limites:
  - saldo confirmado apenas; transações na mempool são ignoradas;
  - a API pública pode limitar requisições (o programa tenta de novo);
  - se as duas APIs falharem para um endereço, nada é gravado e o código
    de saída é 2.

Segurança: este programa não gera chaves, não assina e não transmite
transações. Não há instruções para sacar fundos de terceiros.`;
}

function fail(message, code = EXIT_USAGE) {
  process.stderr.write(`erro: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = {
    addresses: path.join(SCRIPT_DIR, 'addresses.json'),
    addressesExplicit: false,
    state: path.join(SCRIPT_DIR, 'state.json'),
    api: 'blockstream',
    offline: false,
    fixtures: path.join(SCRIPT_DIR, 'fixtures'),
    delay: 150,
    timeout: 15000,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        fail(`faltou valor para ${arg}`);
      }
      i += 1;
      return value;
    };

    if (arg === '-h' || arg === '--help') {
      process.stdout.write(`${usage()}\n`);
      process.exit(EXIT_OK);
    } else if (arg === '--version') {
      process.stdout.write(`${VERSION}\n`);
      process.exit(EXIT_OK);
    } else if (arg === '--offline') {
      opts.offline = true;
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--addresses') {
      opts.addresses = path.resolve(next());
      opts.addressesExplicit = true;
    } else if (arg === '--state') {
      opts.state = path.resolve(next());
    } else if (arg === '--fixtures') {
      opts.fixtures = path.resolve(next());
    } else if (arg === '--api') {
      opts.api = next();
    } else if (arg === '--delay') {
      opts.delay = parseNonNegativeInt(next(), '--delay');
    } else if (arg === '--timeout') {
      opts.timeout = parsePositiveInt(next(), '--timeout');
    } else if (arg.startsWith('--addresses=')) {
      opts.addresses = path.resolve(arg.slice('--addresses='.length));
      opts.addressesExplicit = true;
    } else if (arg.startsWith('--state=')) {
      opts.state = path.resolve(arg.slice('--state='.length));
    } else if (arg.startsWith('--fixtures=')) {
      opts.fixtures = path.resolve(arg.slice('--fixtures='.length));
    } else if (arg.startsWith('--api=')) {
      opts.api = arg.slice('--api='.length);
    } else if (arg.startsWith('--delay=')) {
      opts.delay = parseNonNegativeInt(arg.slice('--delay='.length), '--delay');
    } else if (arg.startsWith('--timeout=')) {
      opts.timeout = parsePositiveInt(arg.slice('--timeout='.length), '--timeout');
    } else {
      fail(`opção desconhecida: ${arg} (use --help)`);
    }
  }

  if (!APIS[opts.api]) {
    fail(`API desconhecida: ${opts.api} (use mempool ou blockstream)`);
  }

  if (opts.offline && !opts.addressesExplicit) {
    opts.addresses = path.join(opts.fixtures, 'addresses.json');
  }

  return opts;
}

function parseNonNegativeInt(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    fail(`${name} deve ser um inteiro >= 0`);
  }
  return n;
}

function parsePositiveInt(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    fail(`${name} deve ser um inteiro > 0`);
  }
  return n;
}

function readJson(file, description) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    fail(`não foi possível ler ${description} em ${file}: ${err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    fail(`${description} em ${file} não é JSON válido: ${err.message}`);
  }
}

function loadAddresses(file) {
  const data = readJson(file, 'a lista de endereços');
  const raw = Array.isArray(data) ? data : data && data.addresses;
  if (!Array.isArray(raw) || raw.length === 0) {
    fail(`${file} precisa conter um array "addresses" não vazio`);
  }

  const seen = new Set();
  return raw.map((item, index) => {
    const entry = typeof item === 'string' ? { address: item } : item;
    if (!entry || typeof entry.address !== 'string') {
      fail(`item ${index + 1} de ${file} não tem "address"`);
    }
    if (!ADDRESS_RE.test(entry.address)) {
      fail(`endereço inválido no item ${index + 1} de ${file}: ${entry.address}`);
    }
    if (seen.has(entry.address)) {
      fail(`endereço duplicado em ${file}: ${entry.address}`);
    }
    seen.add(entry.address);
    return {
      address: entry.address,
      label: typeof entry.label === 'string' && entry.label ? entry.label : entry.address,
      bits: Number.isInteger(entry.bits) ? entry.bits : null,
    };
  });
}

function loadState(file) {
  if (!fs.existsSync(file)) {
    return null;
  }
  const state = readJson(file, 'o snapshot anterior');
  if (!state || state.version !== 1 || typeof state.addresses !== 'object' || state.addresses === null) {
    fail(`snapshot em ${file} inválido (esperado {"version":1,"addresses":{...}})`);
  }
  return state;
}

function validateStats(raw, address) {
  const chain = raw && raw.chain_stats;
  const valid =
    chain &&
    Number.isFinite(chain.funded_txo_sum) &&
    Number.isFinite(chain.spent_txo_sum) &&
    Number.isFinite(chain.tx_count) &&
    chain.funded_txo_sum >= chain.spent_txo_sum;
  if (!valid) {
    throw new Error(`resposta sem chain_stats válido para ${address}`);
  }
  return {
    balance_sats: chain.funded_txo_sum - chain.spent_txo_sum,
    tx_count: chain.tx_count,
  };
}

async function fetchFromApi(address, opts, apiKey) {
  const api = APIS[apiKey];
  const url = `${api.base}/address/${address}`;
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeout);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          'user-agent': `puzzle-monitor/${VERSION} (somente leitura)`,
        },
      });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return validateStats(await response.json(), address);
    } catch (error) {
      lastError = error;
      const retryable =
        error.name === 'AbortError' ||
        error.status === 429 ||
        error.status === undefined ||
        error.status >= 500;
      if (!retryable || attempt === 3) {
        break;
      }
      await sleep(1000 * attempt);
    } finally {
      clearTimeout(timer);
    }
  }

  const reason = lastError && lastError.name === 'AbortError'
    ? `timeout de ${opts.timeout} ms`
    : (lastError && lastError.message) || 'falha desconhecida';
  throw new Error(`falha ao consultar ${address} em ${api.label}: ${reason}`);
}

async function fetchAddress(address, opts) {
  try {
    return await fetchFromApi(address, opts, opts.api);
  } catch (primaryError) {
    // Uma API pública pode falhar de forma isolada para um endereço.
    // Tenta a outra API antes de desistir; o resultado continua sendo
    // somente leitura e vem de dados publicos.
    const fallbackKey = opts.api === 'mempool' ? 'blockstream' : 'mempool';
    try {
      const stats = await fetchFromApi(address, opts, fallbackKey);
      return { ...stats, fallback_api: fallbackKey };
    } catch (fallbackError) {
      throw new Error(`${primaryError.message}; fallback ${APIS[fallbackKey].label} também falhou: ${fallbackError.message}`);
    }
  }
}

function readFixture(address, opts) {
  const file = path.join(opts.fixtures, `${address}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`fixture ausente para ${address}: ${file}`);
  }
  return validateStats(readJson(file, 'a fixture'), address);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatBtc(sats) {
  return `${(sats / 100000000).toFixed(8)} BTC`;
}

function formatSignedBtc(sats) {
  const sign = sats > 0 ? '+' : '-';
  return `${sign}${(Math.abs(sats) / 100000000).toFixed(8)} BTC`;
}

function formatCount(value, singular, plural) {
  return `${value} ${value === 1 ? singular : plural}`;
}

function buildDiff(previous, current) {
  const changes = [];
  const seen = new Set();

  for (const entry of current) {
    seen.add(entry.address);
    const old = previous ? previous.addresses[entry.address] : null;
    const base = {
      label: entry.label,
      address: entry.address,
      balance_sats: entry.balance_sats,
      tx_count: entry.tx_count,
    };

    if (!old) {
      changes.push({ ...base, kind: 'new' });
      continue;
    }

    const oldBalance = Number.isInteger(old.balance_sats) ? old.balance_sats : 0;
    const oldTxs = Number.isInteger(old.tx_count) ? old.tx_count : 0;
    if (oldBalance > 0 && entry.balance_sats === 0) {
      changes.push({ ...base, kind: 'emptied', old_balance_sats: oldBalance, old_tx_count: oldTxs });
    } else if (oldBalance !== entry.balance_sats || oldTxs !== entry.tx_count) {
      changes.push({ ...base, kind: 'changed', old_balance_sats: oldBalance, old_tx_count: oldTxs });
    }
  }

  if (previous) {
    for (const [address, old] of Object.entries(previous.addresses)) {
      if (!seen.has(address)) {
        changes.push({
          kind: 'removed',
          label: old.label || address,
          address,
          balance_sats: Number.isInteger(old.balance_sats) ? old.balance_sats : 0,
          tx_count: Number.isInteger(old.tx_count) ? old.tx_count : 0,
        });
      }
    }
  }

  return changes;
}

function printChanges(changes, previous) {
  if (changes.length === 0) {
    process.stdout.write('  Nenhuma alteração de saldo ou de contagem de transações.\n');
    return;
  }

  const labelWidth = Math.max(...changes.map((c) => c.label.length));
  const addressWidth = Math.max(...changes.map((c) => c.address.length));
  for (const change of changes) {
    const label = change.label.padEnd(labelWidth);
    const address = change.address.padEnd(addressWidth);
    const head = `  ${label}  ${address}  ${formatBtc(change.balance_sats)} (${formatCount(change.tx_count, 'tx', 'txs')})`;

    if (change.kind === 'new') {
      process.stdout.write(`${head}  NOVO\n`);
    } else if (change.kind === 'emptied') {
      process.stdout.write(`${head}  ESVAZIADO (antes ${formatBtc(change.old_balance_sats)})\n`);
    } else if (change.kind === 'removed') {
      process.stdout.write(
        `  ${label}  ${address}  REMOVIDO da lista (saldo anterior ${formatBtc(change.balance_sats)})\n`,
      );
    } else {
      const delta = change.balance_sats - change.old_balance_sats;
      const txDelta = change.tx_count - change.old_tx_count;
      const parts = [];
      if (delta !== 0) {
        parts.push(formatSignedBtc(delta));
      }
      if (txDelta !== 0) {
        parts.push(`${txDelta > 0 ? '+' : ''}${txDelta} tx${Math.abs(txDelta) === 1 ? '' : 's'}`);
      }
      process.stdout.write(`${head}  ${parts.join(', ')}\n`);
    }
  }

  const count = (kind) => changes.filter((c) => c.kind === kind).length;
  const summary = [
    formatCount(count('changed'), 'alteração de saldo', 'alterações de saldo'),
    formatCount(count('emptied'), 'endereço esvaziado', 'endereços esvaziados'),
    formatCount(count('new'), 'novo', 'novos'),
    formatCount(count('removed'), 'removido', 'removidos'),
  ];
  process.stdout.write(`\n  Resumo: ${summary.join(', ')}.\n`);
}

function buildState(entries, opts) {
  const addresses = {};
  for (const entry of entries) {
    addresses[entry.address] = {
      label: entry.label,
      balance_sats: entry.balance_sats,
      tx_count: entry.tx_count,
    };
  }
  return {
    version: 1,
    updated_at: new Date().toISOString(),
    source: opts.offline
      ? 'fixtures (offline)'
      : (entries.some((entry) => entry.fallback_api)
        ? `${APIS[opts.api].label} (+ fallback)`
        : APIS[opts.api].label),
    addresses,
  };
}

function saveState(file, state, opts) {
  if (opts.dryRun) {
    process.stdout.write('  --dry-run: snapshot não gravado.\n');
    return;
  }
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // ignore
    }
    fail(`não foi possível gravar o snapshot em ${file}: ${err.message}`, EXIT_USAGE);
  }
  process.stdout.write(`  Estado salvo em ${file}.\n`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const entries = loadAddresses(opts.addresses);
  const previous = loadState(opts.state);
  const results = [];

  const mode = opts.offline ? 'fixtures locais (offline)' : APIS[opts.api].label;
  process.stdout.write('Monitor passivo de puzzles Bitcoin — somente leitura\n');
  process.stdout.write(`Fonte: ${mode} | ${formatCount(entries.length, 'endereço', 'endereços')} | ${new Date().toISOString()}\n\n`);

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    let stats;
    try {
      stats = opts.offline
        ? readFixture(entry.address, opts)
        : await fetchAddress(entry.address, opts);
    } catch (err) {
      fail(err.message, EXIT_NETWORK);
    }
    results.push({ ...entry, ...stats });
    if (!opts.offline && opts.delay > 0 && i < entries.length - 1) {
      await sleep(opts.delay);
    }
  }

  const fallbackCount = results.filter((entry) => entry.fallback_api).length;
  if (fallbackCount > 0) {
    process.stdout.write(
      `  A API primária falhou em ${formatCount(fallbackCount, 'endereço', 'endereços')}; `
      + 'usei a API alternativa para esses casos.\n',
    );
  }

  if (previous) {
    const changes = buildDiff(previous, results);
    printChanges(changes, previous);
  } else {
    const total = results.reduce((sum, entry) => sum + entry.balance_sats, 0);
    process.stdout.write(
      `  Primeira execução: snapshot inicial com ${formatCount(results.length, 'endereço', 'endereços')}.\n`,
    );
    process.stdout.write(`  Saldo confirmado somado: ${formatBtc(total)}.\n`);
  }

  const state = buildState(results, opts);
  process.stdout.write('\n');
  saveState(opts.state, state, opts);
  return EXIT_OK;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`erro inesperado: ${err && err.stack ? err.stack : err}\n`);
    process.exit(EXIT_USAGE);
  });
