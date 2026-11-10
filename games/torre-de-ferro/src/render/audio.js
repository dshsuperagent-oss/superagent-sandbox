// Áudio 100% sintetizado do Torre de Ferro (WebAudio; zero arquivo).
// Nada aqui pode quebrar o jogo: tudo em try/catch, nenhum console.* e nenhum
// AudioContext antes do primeiro gesto (unlock()).
//
// API fixa: createAudio({ getSettings }) ->
//   { unlock, handle, update, setVolume, setMuted, startMusic, stopMusic,
//     setBossLayer, log, dispose }.
// Extras de conveniência: playUi(nome) e isUnlocked().

const EPS = 0.0001;
const MUSIC_BAR = 2.5; // 96 BPM, compasso 4/4
const EIGHTH = MUSIC_BAR / 8;
const BOSS_DB = 4;
const FADE_S = 1.5;
const MASTER_RAMP = 0.03;

const MAPA_NOME_PARA_ID = {
  deserto: 'deserto',
  neve: 'neve',
  cidade: 'cidade',
};

const PROGRESSIONS = {
  deserto: ['Am', 'F', 'C', 'G'],
  neve: ['Dm', 'Bb', 'F', 'C'],
  cidade: ['Em', 'C', 'G', 'D'],
};

// midi: A4 = 69.
const CHORDS = {
  Am: { bass: 45, tones: [57, 60, 64] }, // A2 | A3 C4 E4
  F: { bass: 41, tones: [53, 57, 60] }, // F2 | F3 A3 C4
  C: { bass: 36, tones: [48, 52, 55] }, // C2 | C3 E3 G3
  G: { bass: 43, tones: [55, 59, 62] }, // G2 | G3 B3 D4
  Dm: { bass: 38, tones: [50, 53, 57] }, // D2 | D3 F3 A3
  Bb: { bass: 34, tones: [53, 57, 60] }, // Bb1 | F3 A3 C4 (pad estável)
  Em: { bass: 40, tones: [52, 55, 59] }, // E2 | E3 G3 B3
  D: { bass: 38, tones: [50, 54, 57] }, // D2 | D3 F#3 A3
};

// Ruído de tiro por tipo de torre.
const TOWER_SHOT = {
  metralhadora: 'metralhadora',
  antiaereo: 'antiaereo',
  morteiro: 'morteiro',
  tesla: 'tesla',
  criogenica: 'criogenica',
  missil: 'missil',
};

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function midiToFreq(midi) {
  return 440 * Math.pow(2, (Number(midi) - 69) / 12);
}

function dbToGain(db) {
  return Math.pow(10, Number(db) / 20);
}

function safeNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function nullAudio() {
  return {
    unlock() {},
    handle() {},
    update() {},
    setVolume() {},
    setMuted() {},
    startMusic() {},
    stopMusic() {},
    setBossLayer() {},
    log() {
      return [];
    },
    dispose() {},
    playUi() {},
    isUnlocked() {
      return false;
    },
  };
}

export function createAudio({ getSettings } = {}) {
  if (typeof window === 'undefined' && typeof AudioContext === 'undefined') return nullAudio();

  let ctx = null;
  let master = null;
  let musicBus = null;
  let bossBus = null;
  let arpBus = null;
  let delayNode = null;
  let delayFeedback = null;
  let delayWet = null;
  let noiseBuffer = null;

  let volume = 0.7;
  let muted = false;
  let bossLayerOn = false;
  let wantMusic = false;
  let disposed = false;
  let unlocked = false;
  let timeline = 0;

  const logEvents = [];
  const lastPlayed = Object.create(null);
  const uiListeners = [];
  let lastState = null;

  const loops = {
    helicoptero: null,
    zepelim: null,
    nextDrone: 0,
    nextBossArp: 0,
    droneLevel: 0,
    heliLevel: 0,
    zepelimLevel: 0,
  };

  const music = {
    running: false,
    interval: 0,
    nextBarTime: 0,
    barIndex: 0,
    mapId: 'deserto',
  };

  // ------------------------------------------------------------- utilidades
  function now() {
    if (ctx && Number.isFinite(ctx.currentTime)) return ctx.currentTime;
    return timeline;
  }

  function atTime(at) {
    const t = Number.isFinite(at) ? at : now();
    return Math.max(now() + 0.001, t);
  }

  function logEvent(type, extra) {
    try {
      const entrada = { t: Math.round(timeline * 1000) / 1000, type };
      if (extra && typeof extra === 'object') {
        for (const chave of Object.keys(extra)) {
          if (extra[chave] !== undefined) entrada[chave] = extra[chave];
        }
      }
      logEvents.push(entrada);
      if (logEvents.length > 400) logEvents.splice(0, logEvents.length - 400);
    } catch (err) {
      /* ignora */
    }
  }

  function readSettings() {
    try {
      if (typeof getSettings !== 'function') return;
      const cfg = getSettings();
      if (!cfg || typeof cfg !== 'object') return;
      if (Number.isFinite(Number(cfg.volume))) volume = clamp01(cfg.volume);
      if (typeof cfg.muted === 'boolean') muted = cfg.muted;
    } catch (err) {
      /* ignora */
    }
  }

  function applyMaster(ramp) {
    if (!ctx || !master) return;
    try {
      const alvo = muted ? 0 : volume;
      const t = ctx.currentTime;
      const dur = Number.isFinite(ramp) ? ramp : MASTER_RAMP;
      master.gain.cancelScheduledValues(t);
      master.gain.setValueAtTime(master.gain.value, t);
      if (dur <= 0) master.gain.setValueAtTime(alvo, t);
      else master.gain.linearRampToValueAtTime(Math.max(EPS, alvo), t + dur);
    } catch (err) {
      /* ignora */
    }
  }

  function makeGain(valor, dest) {
    const node = ctx.createGain();
    node.gain.value = Math.max(EPS, Number(valor) || EPS);
    node.connect(dest || master);
    return node;
  }

  function allow(key, gap) {
    try {
      const t = now();
      const anterior = lastPlayed[key];
      if (Number.isFinite(anterior) && t - anterior < gap) return false;
      lastPlayed[key] = t;
      return true;
    } catch (err) {
      return true;
    }
  }

  function createNoiseBuffer() {
    const duracao = Math.max(0.25, Math.min(1, ctx.sampleRate ? 1 : 1));
    const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * duracao), ctx.sampleRate);
    const dados = buffer.getChannelData(0);
    for (let i = 0; i < dados.length; i += 1) dados[i] = Math.random() * 2 - 1;
    return buffer;
  }

  // ------------------------------------------------------------- síntese
  function playTone(opts) {
    if (!ctx) return;
    try {
      const cfg = opts || {};
      const dur = Math.max(0.02, safeNumber(cfg.dur, 0.2));
      const type = cfg.type || 'sine';
      const gain = Math.max(EPS, safeNumber(cfg.gain, 0.1));
      const attack = Math.min(dur * 0.5, Math.max(0.002, safeNumber(cfg.attack, 0.005)));
      const release = Math.min(dur * 0.9, Math.max(0.005, safeNumber(cfg.release, Math.min(0.08, dur * 0.4))));
      const t0 = atTime(cfg.at);
      const f0 = Math.max(1, safeNumber(cfg.freq, 440));
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(f0, t0);
      if (Number.isFinite(Number(cfg.freqEnd))) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(1, Number(cfg.freqEnd)), t0 + dur);
      }

      let node = osc;
      if (cfg.filter) {
        const filtro = ctx.createBiquadFilter();
        filtro.type = cfg.filter.type || 'lowpass';
        filtro.frequency.setValueAtTime(Math.max(20, safeNumber(cfg.filter.freq, 900)), t0);
        if (Number.isFinite(Number(cfg.filter.freqEnd))) {
          filtro.frequency.exponentialRampToValueAtTime(Math.max(20, Number(cfg.filter.freqEnd)), t0 + dur);
        }
        filtro.Q.value = safeNumber(cfg.filter.Q, 0.8);
        node.connect(filtro);
        node = filtro;
      }

      const env = ctx.createGain();
      env.gain.setValueAtTime(EPS, t0);
      env.gain.exponentialRampToValueAtTime(gain, t0 + attack);
      env.gain.setValueAtTime(gain, Math.max(t0 + attack, t0 + dur - release));
      env.gain.exponentialRampToValueAtTime(EPS, t0 + dur);

      node.connect(env);
      env.connect(cfg.dest || master);
      osc.start(t0);
      osc.stop(t0 + dur + 0.03);
      return osc;
    } catch (err) {
      return null;
    }
  }

  function playNoise(opts) {
    if (!ctx || !noiseBuffer) return;
    try {
      const cfg = opts || {};
      const dur = Math.max(0.02, Math.min(1, safeNumber(cfg.dur, 0.2)));
      const gain = Math.max(EPS, safeNumber(cfg.gain, 0.08));
      const attack = Math.min(dur * 0.5, Math.max(0.002, safeNumber(cfg.attack, 0.004)));
      const t0 = atTime(cfg.at);
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer;
      const filtro = ctx.createBiquadFilter();
      filtro.type = cfg.type || 'highpass';
      filtro.frequency.setValueAtTime(Math.max(20, safeNumber(cfg.freq, 1000)), t0);
      if (Number.isFinite(Number(cfg.freqEnd))) {
        filtro.frequency.exponentialRampToValueAtTime(Math.max(20, Number(cfg.freqEnd)), t0 + dur);
      }
      filtro.Q.value = safeNumber(cfg.Q, 1);
      const env = ctx.createGain();
      env.gain.setValueAtTime(EPS, t0);
      env.gain.exponentialRampToValueAtTime(gain, t0 + attack);
      env.gain.exponentialRampToValueAtTime(EPS, t0 + dur);
      src.connect(filtro);
      filtro.connect(env);
      env.connect(cfg.dest || master);
      src.start(t0);
      src.stop(t0 + dur + 0.02);
    } catch (err) {
      /* ignora */
    }
  }

  function playChord(freqs, dur, gainEach, type, filtroFreq) {
    if (!ctx || !Array.isArray(freqs)) return;
    try {
      for (let i = 0; i < freqs.length; i += 1) {
        playTone({
          type: type || 'triangle',
          freq: freqs[i],
          dur,
          gain: gainEach,
          attack: 0.05,
          release: Math.min(0.7, dur * 0.4),
          filter: filtroFreq ? { type: 'lowpass', freq: filtroFreq } : null,
        });
      }
    } catch (err) {
      /* ignora */
    }
  }

  function playTesla() {
    if (!ctx) return;
    try {
      const t0 = atTime();
      const dur = 0.2;
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.setValueAtTime(900, t0);
      const amp = ctx.createGain();
      amp.gain.value = 0.5;
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.setValueAtTime(30, t0);
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 0.5;
      lfo.connect(lfoGain);
      lfoGain.connect(amp.gain);
      const env = ctx.createGain();
      env.gain.setValueAtTime(EPS, t0);
      env.gain.exponentialRampToValueAtTime(0.09, t0 + 0.01);
      env.gain.exponentialRampToValueAtTime(EPS, t0 + dur);
      osc.connect(amp);
      amp.connect(env);
      env.connect(master);
      osc.start(t0);
      lfo.start(t0);
      osc.stop(t0 + dur + 0.02);
      lfo.stop(t0 + dur + 0.02);
    } catch (err) {
      /* ignora */
    }
  }

  // ------------------------------------------------------------- efeitos (SFX)
  const sfx = {
    metralhadora() {
      if (!allow('metralhadora', 0.045)) return;
      playNoise({ dur: 0.06, gain: 0.1, type: 'highpass', freq: 1800 });
      playTone({ type: 'square', freq: 220, freqEnd: 90, dur: 0.06, gain: 0.07 });
    },
    antiaereo() {
      if (!allow('antiaereo', 0.08)) return;
      playTone({ type: 'sine', freq: 140, freqEnd: 45, dur: 0.12, gain: 0.15 });
      playNoise({ dur: 0.12, gain: 0.08, type: 'lowpass', freq: 700 });
    },
    morteiro() {
      if (!allow('morteiro', 0.1)) return;
      playTone({ type: 'sine', freq: 90, freqEnd: 35, dur: 0.22, gain: 0.18 });
      playNoise({ dur: 0.22, gain: 0.1, type: 'lowpass', freq: 500 });
    },
    tesla() {
      if (!allow('tesla', 0.06)) return;
      playTesla();
    },
    criogenica() {
      if (!allow('criogenica', 0.06)) return;
      playTone({ type: 'sine', freq: 1200, freqEnd: 400, dur: 0.18, gain: 0.085 });
    },
    missil() {
      if (!allow('missil', 0.15)) return;
      playTone({ type: 'sawtooth', freq: 300, freqEnd: 1400, dur: 0.25, gain: 0.07 });
    },
    tropa() {
      if (!allow('tropa', 0.08)) return;
      playNoise({ dur: 0.25, gain: 0.09, type: 'bandpass', freq: 400, Q: 1.2 });
    },
    tiroTropa() {
      if (!allow('tiro-tropa', 0.05)) return;
      playNoise({ dur: 0.05, gain: 0.06, type: 'highpass', freq: 1400 });
      playTone({ type: 'square', freq: 180, freqEnd: 90, dur: 0.04, gain: 0.04 });
    },
    explosaoPequena() {
      if (!allow('explosao-pequena', 0.04)) return;
      // ruído 900 -> 150 Hz, 350 ms, ganho 0,25 (spec)
      playNoise({ dur: 0.35, gain: 0.25, type: 'lowpass', freq: 900, freqEnd: 150 });
    },
    explosaoGrande() {
      if (!allow('explosao-grande', 0.07)) return;
      // ruído 600 -> 80 Hz + sine 60 -> 30 Hz, 700 ms, ganho 0,40 (spec)
      playNoise({ dur: 0.7, gain: 0.22, type: 'lowpass', freq: 600, freqEnd: 80 });
      playTone({ type: 'sine', freq: 60, freqEnd: 30, dur: 0.7, gain: 0.2 });
    },
    explosaoBase() {
      if (!allow('explosao-base', 0.09)) return;
      // sine 70 -> 35 Hz + ruído, 500 ms, ganho 0,35 (spec)
      playTone({ type: 'sine', freq: 70, freqEnd: 35, dur: 0.5, gain: 0.2 });
      playNoise({ dur: 0.5, gain: 0.15, type: 'lowpass', freq: 400 });
    },
    construir() {
      if (!allow('construir', 0.05)) return;
      playTone({ type: 'triangle', freq: 440, freqEnd: 660, dur: 0.18, gain: 0.09 });
    },
    melhorar() {
      if (!allow('melhorar', 0.05)) return;
      const notas = [523.25, 659.25, 783.99];
      for (let i = 0; i < notas.length; i += 1) {
        playTone({ type: 'triangle', freq: notas[i], dur: 0.12, gain: 0.07, at: now() + i * 0.07 });
      }
    },
    vender() {
      if (!allow('vender', 0.05)) return;
      playTone({ type: 'sawtooth', freq: 660, freqEnd: 330, dur: 0.18, gain: 0.08 });
    },
    clique() {
      if (!allow('clique', 0.03)) return;
      playTone({ type: 'sine', freq: 880, dur: 0.05, gain: 0.045 });
    },
    hover() {
      if (!allow('hover', 0.06)) return;
      playTone({ type: 'sine', freq: 1320, dur: 0.03, gain: 0.025 });
    },
    erro() {
      if (!allow('erro', 0.08)) return;
      playTone({ type: 'square', freq: 160, dur: 0.25, gain: 0.08 });
    },
    onda() {
      if (!allow('onda', 0.2)) return;
      playTone({ type: 'square', freq: 330, freqEnd: 440, dur: 0.28, gain: 0.08 });
    },
    fimOnda() {
      if (!allow('fim-onda', 0.2)) return;
      playTone({ type: 'triangle', freq: 523.25, dur: 0.16, gain: 0.05 });
      playTone({ type: 'triangle', freq: 783.99, dur: 0.22, gain: 0.05, at: now() + 0.12 });
    },
    vitoria() {
      if (!allow('vitoria', 1)) return;
      playChord([261.63, 329.63, 392.0, 523.25], 2.2, 0.06, 'triangle', 2200);
    },
    derrota() {
      if (!allow('derrota', 1)) return;
      playChord([220.0, 261.63, 329.63, 174.61], 2.0, 0.06, 'sawtooth', 720);
    },
    chefe() {
      if (!allow('chefe', 0.5)) return;
      const notas = [220, 330, 440];
      for (let i = 0; i < notas.length; i += 1) {
        playTone({ type: 'sawtooth', freq: notas[i], dur: 0.18, gain: 0.075, at: now() + i * 0.15, filter: { type: 'lowpass', freq: 1200 } });
      }
      playNoise({ dur: 0.5, gain: 0.06, type: 'lowpass', freq: 260 });
    },
    gelo() {
      if (!allow('gelo', 0.08)) return;
      playTone({ type: 'sine', freq: 1800, freqEnd: 1200, dur: 0.12, gain: 0.03 });
    },
    tropaMorre() {
      if (!allow('tropa-morre', 0.1)) return;
      playNoise({ dur: 0.18, gain: 0.05, type: 'lowpass', freq: 300 });
    },
  };

  const UI_SFX = {
    clique: 'clique',
    click: 'clique',
    hover: 'hover',
    erro: 'erro',
    error: 'erro',
    onda: 'onda',
    construir: 'construir',
    build: 'construir',
    melhorar: 'melhorar',
    upgrade: 'melhorar',
    vender: 'vender',
    sell: 'vender',
    tropa: 'tropa',
    vitoria: 'vitoria',
    derrota: 'derrota',
  };

  function playUi(nome) {
    try {
      const key = String(nome || '').toLowerCase();
      const fn = sfx[UI_SFX[key]];
      if (typeof fn === 'function') fn();
    } catch (err) {
      /* ignora */
    }
  }

  // ------------------------------------------------------------- loops de inimigos
  function createLoop(type) {
    if (!ctx || loops[type]) return loops[type];
    try {
      const t0 = now();
      const osc = ctx.createOscillator();
      const amp = ctx.createGain();
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      amp.gain.value = 0;
      if (type === 'helicoptero') {
        osc.type = 'sawtooth';
        osc.frequency.value = 90;
        lfo.type = 'sine';
        lfo.frequency.value = 12;
        lfoGain.gain.value = 0.5;
      } else {
        osc.type = 'sine';
        osc.frequency.value = 55;
        lfo.type = 'sine';
        lfo.frequency.value = 8;
        lfoGain.gain.value = 0.5;
      }
      const env = ctx.createGain();
      env.gain.value = 0.5;
      lfo.connect(lfoGain);
      lfoGain.connect(env.gain);
      osc.connect(env);
      env.connect(amp);
      amp.connect(master);
      osc.start(t0);
      lfo.start(t0);
      loops[type] = { osc, lfo, amp };
    } catch (err) {
      loops[type] = null;
    }
    return loops[type];
  }

  function setLoopLevel(type, level) {
    const loop = createLoop(type);
    if (!loop || !ctx) return;
    try {
      loop.amp.gain.setTargetAtTime(Math.max(EPS, level), now(), 0.12);
    } catch (err) {
      /* ignora */
    }
  }

  function updateLoops(state) {
    if (!ctx || !state || !Array.isArray(state.enemies)) return;
    try {
      let helicopteros = 0;
      let zepelins = 0;
      let drones = 0;
      let chefe = false;
      for (const e of state.enemies) {
        if (!e) continue;
        if (e.type === 'helicoptero') helicopteros += 1;
        else if (e.type === 'zepelim') zepelins += 1;
        else if (e.type === 'drone') drones += 1;
        if (e.boss) chefe = true;
      }
      if (state.boss) chefe = true;

      const heliAlvo = helicopteros > 0 ? Math.min(0.06, 0.03 + 0.01 * Math.min(3, helicopteros)) : 0;
      const zepAlvo = zepelins > 0 ? Math.min(0.06, 0.035 + 0.008 * Math.min(3, zepelins)) : 0;
      if (Math.abs(heliAlvo - loops.heliLevel) > 0.002) {
        loops.heliLevel = heliAlvo;
        setLoopLevel('helicoptero', heliAlvo);
      }
      if (Math.abs(zepAlvo - loops.zepelimLevel) > 0.002) {
        loops.zepelimLevel = zepAlvo;
        setLoopLevel('zepelim', zepAlvo);
      }

      // Drone: sawtooth 160 Hz com vibrato de 5 Hz, retrigger a cada 1,2 s.
      if (drones > 0 && now() >= loops.nextDrone) {
        loops.nextDrone = now() + 1.2;
        if (allow('drone', 0.5)) {
          const t0 = now();
          const osc = ctx.createOscillator();
          osc.type = 'sawtooth';
          osc.frequency.setValueAtTime(160, t0);
          const lfo = ctx.createOscillator();
          lfo.type = 'sine';
          lfo.frequency.setValueAtTime(5, t0);
          const lfoGain = ctx.createGain();
          lfoGain.gain.value = 8;
          lfo.connect(lfoGain);
          lfoGain.connect(osc.frequency);
          const env = ctx.createGain();
          env.gain.setValueAtTime(EPS, t0);
          env.gain.exponentialRampToValueAtTime(0.045, t0 + 0.02);
          env.gain.exponentialRampToValueAtTime(EPS, t0 + 0.38);
          osc.connect(env);
          env.connect(master);
          osc.start(t0);
          lfo.start(t0);
          osc.stop(t0 + 0.4);
          lfo.stop(t0 + 0.4);
        }
      }

      // Camada de +4 dB acompanha a presença real do chefe.
      if (chefe !== bossLayerOn) setBossLayer(chefe);

      // Chefe: arpejo 220 -> 330 -> 440 Hz.
      if (chefe && now() >= loops.nextBossArp) {
        loops.nextBossArp = now() + 1.8;
        if (allow('chefe-arp', 0.5)) {
          const notas = [220, 330, 440];
          for (let i = 0; i < notas.length; i += 1) {
            playTone({
              type: 'sawtooth',
              freq: notas[i],
              dur: 0.16,
              gain: 0.045,
              at: now() + i * 0.16,
              filter: { type: 'lowpass', freq: 1100 },
            });
          }
        }
      }
    } catch (err) {
      /* ignora */
    }
  }

  // ------------------------------------------------------------- trilha
  // O main nem sempre entrega state ao áudio antes da primeira onda; nesse caso
  // usamos o nome do setor que o HUD já mostra para escolher a progressão certa.
  function detectMapId() {
    if (lastState && typeof lastState.mapId === 'string' && PROGRESSIONS[lastState.mapId]) {
      return lastState.mapId;
    }
    try {
      if (typeof document !== 'undefined' && document && typeof document.getElementById === 'function') {
        const node = document.getElementById('hud-mapa');
        const nome = node && node.textContent ? String(node.textContent).trim().toLowerCase() : '';
        if (MAPA_NOME_PARA_ID[nome]) return MAPA_NOME_PARA_ID[nome];
      }
    } catch (err) {
      /* ignora */
    }
    return music.mapId || 'deserto';
  }

  function scheduleBar(index, t0) {
    if (!ctx) return;
    try {
      const mapId = detectMapId();
      music.mapId = mapId;
      const prog = PROGRESSIONS[mapId] || PROGRESSIONS.deserto;
      const nome = prog[index % prog.length];
      const acorde = CHORDS[nome] || CHORDS.Am;

      // Pad: saw + lowpass 900 Hz, notas do acorde.
      for (const midi of acorde.tones) {
        playTone({
          type: 'sawtooth',
          freq: midiToFreq(midi),
          dur: MUSIC_BAR * 0.96,
          gain: 0.026,
          attack: 0.18,
          release: 0.55,
          at: t0,
          filter: { type: 'lowpass', freq: 900 },
          dest: musicBus,
        });
      }

      // Baixo: square nas batidas 1 e 3 + oitava nos contratempos.
      const baixo = midiToFreq(acorde.bass);
      for (const [batida, freq, dur, ganho] of [
        [0, baixo, 0.42, 0.05],
        [1, baixo * 2, 0.22, 0.032],
        [2, baixo, 0.42, 0.05],
        [3, baixo * 2, 0.22, 0.032],
      ]) {
        playTone({
          type: 'square',
          freq,
          dur,
          gain: ganho,
          attack: 0.01,
          release: 0.06,
          at: t0 + batida * (MUSIC_BAR / 4),
          dest: musicBus,
        });
      }

      // Percussão: bumbo (1 e 3), caixa (2 e 4), chimbal em colcheias.
      for (const batida of [0, 2]) {
        playTone({
          type: 'sine',
          freq: 150,
          freqEnd: 45,
          dur: 0.14,
          gain: 0.15,
          at: t0 + batida * (MUSIC_BAR / 4),
          dest: musicBus,
        });
      }
      for (const batida of [1, 3]) {
        playNoise({
          dur: 0.1,
          gain: 0.06,
          type: 'bandpass',
          freq: 1800,
          Q: 1.4,
          at: t0 + batida * (MUSIC_BAR / 4),
          dest: musicBus,
        });
      }
      for (let i = 0; i < 8; i += 1) {
        playNoise({
          dur: 0.03,
          gain: 0.02,
          type: 'highpass',
          freq: 7000,
          at: t0 + i * EIGHTH,
          dest: musicBus,
        });
      }

      // Arpejo: triangle com delay (destino compartilhado).
      const padAlt = acorde.tones.map((m) => m + 12);
      const padrao = [0, 1, 2, 1, 2, 0, 1, 2];
      for (let i = 0; i < 8; i += 1) {
        const midi = padAlt[padrao[i] % padAlt.length];
        playTone({
          type: 'triangle',
          freq: midiToFreq(midi),
          dur: EIGHTH * 0.85,
          gain: 0.03,
          attack: 0.01,
          release: 0.08,
          at: t0 + i * EIGHTH,
          dest: arpBus || musicBus,
        });
      }

      // Camada de chefe (+4 dB no bossBus): drone grave + tambor.
      if (bossLayerOn) {
        playTone({
          type: 'sawtooth',
          freq: midiToFreq(Math.max(36, acorde.bass - 12)),
          dur: MUSIC_BAR * 0.9,
          gain: 0.035,
          attack: 0.2,
          release: 0.4,
          at: t0,
          filter: { type: 'lowpass', freq: 420 },
          dest: bossBus || musicBus,
        });
        for (const batida of [0, 2]) {
          playTone({
            type: 'sine',
            freq: 82,
            freqEnd: 38,
            dur: 0.22,
            gain: 0.07,
            at: t0 + batida * (MUSIC_BAR / 4),
            dest: bossBus || musicBus,
          });
        }
      }
    } catch (err) {
      /* ignora */
    }
  }

  function scheduleMusic() {
    if (!ctx || !music.running) return;
    try {
      const horizonte = now() + 0.6;
      if (music.nextBarTime < now() - 1) music.nextBarTime = now() + 0.05;
      let guarda = 0;
      while (music.nextBarTime < horizonte && guarda < 8) {
        scheduleBar(music.barIndex, music.nextBarTime);
        music.nextBarTime += MUSIC_BAR;
        music.barIndex += 1;
        guarda += 1;
      }
    } catch (err) {
      /* ignora */
    }
  }

  function beginMusic() {
    if (disposed || !ctx || music.running) return;
    try {
      readSettings();
      music.running = true;
      music.barIndex = 0;
      music.nextBarTime = now() + 0.08;
      const t = ctx.currentTime;
      if (musicBus) {
        musicBus.gain.cancelScheduledValues(t);
        musicBus.gain.setValueAtTime(Math.max(EPS, musicBus.gain.value), t);
        musicBus.gain.linearRampToValueAtTime(1, t + FADE_S);
      }
      scheduleMusic();
      if (!music.interval && typeof setInterval === 'function') {
        music.interval = setInterval(() => {
          try {
            scheduleMusic();
          } catch (err) {
            /* ignora */
          }
        }, 220);
      }
      logEvent('music', { action: 'start', mapId: music.mapId });
    } catch (err) {
      /* ignora */
    }
  }

  function haltMusic() {
    if (!ctx) return;
    try {
      music.running = false;
      if (music.interval) {
        clearInterval(music.interval);
        music.interval = 0;
      }
      const t = ctx.currentTime;
      if (musicBus) {
        musicBus.gain.cancelScheduledValues(t);
        musicBus.gain.setValueAtTime(Math.max(EPS, musicBus.gain.value), t);
        musicBus.gain.linearRampToValueAtTime(EPS, t + FADE_S);
      }
      logEvent('music', { action: 'stop' });
    } catch (err) {
      /* ignora */
    }
  }

  // ------------------------------------------------------------- unlock
  function installUiListeners() {
    if (uiListeners.length > 0 || typeof document === 'undefined' || !document.addEventListener) return;
    try {
      const alvoValido = (alvo) => {
        if (!alvo || typeof alvo.closest !== 'function') return false;
        return !!alvo.closest('button, .map-card, .torre-card, .tropa-card');
      };
      const clique = (ev) => {
        try {
          if (alvoValido(ev && ev.target)) sfx.clique();
        } catch (err) {
          /* ignora */
        }
      };
      const hover = (ev) => {
        try {
          if (alvoValido(ev && ev.target)) sfx.hover();
        } catch (err) {
          /* ignora */
        }
      };
      document.addEventListener('click', clique, true);
      document.addEventListener('pointerover', hover, true);
      uiListeners.push([document, 'click', clique], [document, 'pointerover', hover]);
    } catch (err) {
      /* ignora */
    }
  }

  function unlock() {
    if (disposed || unlocked) {
      if (ctx && ctx.state === 'suspended') {
        try {
          const p = ctx.resume();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch (err) {
          /* ignora */
        }
      }
      return;
    }
    try {
      const AC = (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)) ||
        (typeof AudioContext !== 'undefined' ? AudioContext : null);
      if (!AC) return;
      readSettings();
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : Math.max(EPS, volume);
      master.connect(ctx.destination);

      musicBus = ctx.createGain();
      musicBus.gain.value = EPS;
      musicBus.connect(master);

      bossBus = ctx.createGain();
      bossBus.gain.value = bossLayerOn ? dbToGain(BOSS_DB) : EPS;
      bossBus.connect(musicBus);

      arpBus = ctx.createGain();
      arpBus.gain.value = 1;
      arpBus.connect(musicBus);

      delayNode = ctx.createDelay(1);
      delayNode.delayTime.value = 0.28;
      delayFeedback = ctx.createGain();
      delayFeedback.gain.value = 0.3;
      delayWet = ctx.createGain();
      delayWet.gain.value = 0.5;
      arpBus.connect(delayNode);
      delayNode.connect(delayFeedback);
      delayFeedback.connect(delayNode);
      delayNode.connect(delayWet);
      delayWet.connect(musicBus);

      noiseBuffer = createNoiseBuffer();
      unlocked = true;
      installUiListeners();
      logEvent('unlock', { volume, muted });

      if (ctx.state === 'suspended') {
        const p = ctx.resume();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }
      if (wantMusic) beginMusic();
    } catch (err) {
      ctx = null;
      master = null;
      musicBus = null;
      bossBus = null;
      arpBus = null;
      delayNode = null;
      delayFeedback = null;
      delayWet = null;
      noiseBuffer = null;
      unlocked = false;
    }
  }

  // ------------------------------------------------------------- eventos
  function handleShot(ev) {
    const tipo = ev.towerType || (ev.kind === 'chain' ? 'tesla' : null);
    const chave = TOWER_SHOT[tipo] || null;
    if (chave && typeof sfx[chave] === 'function') {
      sfx[chave]();
      logEvent('shot', { towerType: tipo });
      return;
    }
    sfx.metralhadora();
    logEvent('shot', { towerType: tipo || 'desconhecida' });
  }

  function handleExplosion(ev) {
    const size = ev.size || (ev.kind === 'morte' ? 'small' : 'small');
    if (size === 'base') sfx.explosaoBase();
    else if (size === 'large') sfx.explosaoGrande();
    else sfx.explosaoPequena();
    logEvent('explosion', { size, kind: ev.kind });
  }

  function handleEvent(ev, pularMissileHit) {
    if (!ev || !ev.type) return;
    switch (ev.type) {
      case 'shot':
        handleShot(ev);
        break;
      case 'troopShot':
        sfx.tiroTropa();
        logEvent('troopShot', { troopType: ev.troopType });
        break;
      case 'missileHit':
        // Se o mesmo passo já emitiu 'explosion' no mesmo lugar, não duplica.
        if (!pularMissileHit) sfx.explosaoPequena();
        logEvent('missileHit');
        break;
      case 'explosion':
        handleExplosion(ev);
        break;
      case 'leak':
        sfx.explosaoBase();
        logEvent('leak', { damage: ev.damage, lives: ev.lives });
        break;
      case 'waveStart':
        sfx.onda();
        logEvent('waveStart', { wave: ev.wave });
        break;
      case 'waveEnd':
        sfx.fimOnda();
        logEvent('waveEnd', { wave: ev.wave });
        break;
      case 'bossSpawn':
        sfx.chefe();
        setBossLayer(true);
        logEvent('bossSpawn', { name: ev.name });
        break;
      case 'slow':
        sfx.gelo();
        logEvent('slow', { amount: ev.amount });
        break;
      case 'build':
        sfx.construir();
        logEvent('build', { towerType: ev.towerType });
        break;
      case 'upgrade':
        sfx.melhorar();
        logEvent('upgrade', { towerType: ev.towerType, level: ev.level });
        break;
      case 'sell':
        sfx.vender();
        logEvent('sell', { towerType: ev.towerType, refund: ev.refund });
        break;
      case 'troopDeploy':
        sfx.tropa();
        logEvent('troopDeploy', { troopType: ev.troopType });
        break;
      case 'troopDeath':
        sfx.tropaMorre();
        logEvent('troopDeath', { troopType: ev.troopType, reason: ev.reason });
        break;
      case 'victory':
        sfx.vitoria();
        setBossLayer(false);
        haltMusic();
        logEvent('victory', { mapId: ev.mapId, lives: ev.lives, stars: ev.stars });
        break;
      case 'defeat':
        sfx.derrota();
        setBossLayer(false);
        haltMusic();
        logEvent('defeat', { mapId: ev.mapId, lives: ev.lives });
        break;
      case 'ui':
      case 'clique':
      case 'click':
      case 'hover':
      case 'erro':
      case 'error':
        playUi(ev.type === 'ui' ? ev.name : ev.type);
        logEvent('ui', { name: ev.type === 'ui' ? ev.name : ev.type });
        break;
      default:
        break;
    }
  }

  function handle(events, state) {
    if (disposed) return;
    try {
      if (state && typeof state === 'object') {
        lastState = state;
        updateLoops(state);
      }
      if (!Array.isArray(events) || events.length === 0) return;
      // Evita impacto duplicado quando 'missileHit' e 'explosion' vêm juntos.
      const explosoes = [];
      for (const ev of events) {
        if (ev && ev.type === 'explosion') explosoes.push(ev);
      }
      for (const ev of events) {
        if (!ev || typeof ev !== 'object') continue;
        let pularMissileHit = false;
        if (ev.type === 'missileHit' && explosoes.length > 0) {
          pularMissileHit = explosoes.some(
            (ex) => Math.abs(safeNumber(ex.x) - safeNumber(ev.x)) < 0.6 && Math.abs(safeNumber(ex.z) - safeNumber(ev.z)) < 0.6,
          );
        }
        try {
          handleEvent(ev, pularMissileHit);
        } catch (err) {
          /* evento isolado nunca quebra o jogo */
        }
      }
    } catch (err) {
      /* nunca propaga */
    }
  }

  // ------------------------------------------------------------- update
  function update(dt) {
    if (disposed) return;
    try {
      timeline += Math.max(0, Math.min(0.1, Number(dt) || 0));
      if (!ctx) return;
      if (wantMusic && !music.running) beginMusic();
      scheduleMusic();
      if (lastState) updateLoops(lastState);
    } catch (err) {
      /* ignora */
    }
  }

  // ------------------------------------------------------------- setters
  function setVolume(v) {
    try {
      volume = clamp01(v);
      applyMaster(MASTER_RAMP);
      logEvent('volume', { volume });
    } catch (err) {
      /* ignora */
    }
  }

  function setMuted(m) {
    try {
      muted = !!m;
      applyMaster(MASTER_RAMP);
      logEvent('muted', { muted });
    } catch (err) {
      /* ignora */
    }
  }

  function startMusic() {
    wantMusic = true;
    if (!ctx) return;
    beginMusic();
  }

  function stopMusic() {
    wantMusic = false;
    if (!ctx) {
      music.running = false;
      return;
    }
    haltMusic();
  }

  function setBossLayer(on) {
    try {
      bossLayerOn = !!on;
      if (!ctx || !bossBus) {
        logEvent('bossLayer', { on: bossLayerOn });
        return;
      }
      const t = ctx.currentTime;
      const alvo = bossLayerOn ? dbToGain(BOSS_DB) : EPS;
      bossBus.gain.cancelScheduledValues(t);
      bossBus.gain.setValueAtTime(Math.max(EPS, bossBus.gain.value), t);
      bossBus.gain.linearRampToValueAtTime(alvo, t + 0.3);
      logEvent('bossLayer', { on: bossLayerOn });
    } catch (err) {
      /* ignora */
    }
  }

  function log() {
    try {
      return logEvents.slice();
    } catch (err) {
      return [];
    }
  }

  function isUnlocked() {
    return !!ctx;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    try {
      wantMusic = false;
      if (music.interval) {
        clearInterval(music.interval);
        music.interval = 0;
      }
      for (const [node, tipo, fn] of uiListeners) {
        try {
          node.removeEventListener(tipo, fn, true);
        } catch (err) {
          /* ignora */
        }
      }
      uiListeners.length = 0;
      for (const chave of ['helicoptero', 'zepelim']) {
        const loop = loops[chave];
        if (loop) {
          try {
            loop.osc.stop();
            loop.lfo.stop();
          } catch (err) {
            /* ignora */
          }
          loops[chave] = null;
        }
      }
      if (ctx && typeof ctx.close === 'function') {
        const p = ctx.close();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }
      ctx = null;
      master = null;
      musicBus = null;
      bossBus = null;
      arpBus = null;
      delayNode = null;
      delayFeedback = null;
      delayWet = null;
      noiseBuffer = null;
      unlocked = false;
      music.running = false;
      lastState = null;
    } catch (err) {
      /* ignora */
    }
  }

  readSettings();

  return {
    unlock,
    handle,
    update,
    setVolume,
    setMuted,
    startMusic,
    stopMusic,
    setBossLayer,
    log,
    dispose,
    // extras (não fazem parte da API fixa; main pode usar se quiser)
    playUi,
    isUnlocked,
  };
}

export default createAudio;
