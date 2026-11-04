'use strict';

/**
 * Codificador PNG mínimo (Node stdlib apenas) e gerador de imagens
 * placeholder usado pelo `fake-blender.js`.
 *
 * O PNG gerado é RGBA de 8 bits, sem interlace, com filtro "None" em todas
 * as linhas. Isso é suficiente para previews de teste e evita qualquer
 * dependência externa (canvas, sharp, etc.).
 */

const zlib = require('node:zlib');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

/**
 * @param {number} width
 * @param {number} height
 * @param {Buffer} rgba width * height * 4 bytes
 * @returns {Buffer} bytes do PNG
 */
function encodePNG(width, height, rgba) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error('dimensões inválidas para PNG');
  }
  const stride = width * 4;
  if (rgba.length !== stride * height) {
    throw new Error(`buffer RGBA com tamanho inesperado: ${rgba.length} (esperado ${stride * height})`);
  }
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filtro None
    rgba.copy(raw, rowStart + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compressão
  ihdr[11] = 0; // filtro
  ihdr[12] = 0; // interlace
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Lê largura/altura de um PNG (IHDR). Retorna null se não for PNG. */
function readPNGDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

// ---------------------------------------------------------------------------
// Desenho simples em RGBA (sem anti-aliasing sofisticado; suficiente para
// placeholders determinísticos).
// ---------------------------------------------------------------------------

function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function hexToRgb(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex));
  if (!match) return [0.5, 0.5, 0.5];
  return [
    parseInt(match[1].slice(0, 2), 16) / 255,
    parseInt(match[1].slice(2, 4), 16) / 255,
    parseInt(match[1].slice(4, 6), 16) / 255,
  ];
}

function colorOf(value, fallback) {
  if (typeof value === 'string') return hexToRgb(value);
  if (Array.isArray(value) && value.length === 3 && value.every((v) => Number.isFinite(v))) {
    return value.map((v) => clamp01(Number(v)));
  }
  return fallback;
}

function srgbEncode(linear) {
  const c = clamp01(linear);
  return Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055));
}

class Canvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.pixels = Buffer.alloc(width * height * 4);
  }

  set(x, y, r, g, b, a = 1) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height || a <= 0) return;
    const i = (y * this.width + x) * 4;
    const srcA = clamp01(a);
    const dstA = this.pixels[i + 3] / 255;
    const outA = srcA + dstA * (1 - srcA);
    if (outA <= 0) return;
    const blend = (src, dst) => Math.round((src * srcA + dst * dstA * (1 - srcA)) / outA);
    this.pixels[i] = blend(srgbEncode(r), this.pixels[i]);
    this.pixels[i + 1] = blend(srgbEncode(g), this.pixels[i + 1]);
    this.pixels[i + 2] = blend(srgbEncode(b), this.pixels[i + 2]);
    this.pixels[i + 3] = Math.round(outA * 255);
  }

  fillRect(x0, y0, x1, y1, color, alpha = 1) {
    const left = Math.max(0, Math.floor(Math.min(x0, x1)));
    const right = Math.min(this.width, Math.ceil(Math.max(x0, x1)));
    const top = Math.max(0, Math.floor(Math.min(y0, y1)));
    const bottom = Math.min(this.height, Math.ceil(Math.max(y0, y1)));
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        this.set(x, y, color[0], color[1], color[2], alpha);
      }
    }
  }

  fillEllipse(cx, cy, rx, ry, color, alpha = 1) {
    if (rx <= 0 || ry <= 0) return;
    const left = Math.max(0, Math.floor(cx - rx));
    const right = Math.min(this.width, Math.ceil(cx + rx));
    const top = Math.max(0, Math.floor(cy - ry));
    const bottom = Math.min(this.height, Math.ceil(cy + ry));
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        const dx = (x + 0.5 - cx) / rx;
        const dy = (y + 0.5 - cy) / ry;
        const d = dx * dx + dy * dy;
        if (d <= 1) this.set(x, y, color[0], color[1], color[2], alpha);
      }
    }
  }

  radialGlow(cx, cy, radius, color, intensity = 1) {
    if (radius <= 0) return;
    const left = Math.max(0, Math.floor(cx - radius));
    const right = Math.min(this.width, Math.ceil(cx + radius));
    const top = Math.max(0, Math.floor(cy - radius));
    const bottom = Math.min(this.height, Math.ceil(cy + radius));
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const t = Math.sqrt(dx * dx + dy * dy) / radius;
        if (t >= 1) continue;
        const falloff = (1 - t) ** 2;
        this.set(x, y, color[0], color[1], color[2], clamp01(falloff * intensity));
      }
    }
  }
}

function hash2d(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed * 2246822519) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/**
 * Gera um PNG placeholder determinístico a partir do spec.
 * A imagem é uma "foto de estúdio" abstrata: fundo, piso, luzes e formas
 * derivadas dos objetos/materiais — o suficiente para validar o fluxo.
 */
function renderPlaceholder(spec, { stage = 'preview', width, height } = {}) {
  const outWidth = Math.max(16, Math.round(width || (stage === 'preview' ? 640 : 1200)));
  const outHeight = Math.max(16, Math.round(height || (stage === 'preview' ? 360 : 800)));
  const canvas = new Canvas(outWidth, outHeight);

  const worldColor = colorOf(spec && spec.world && spec.world.color, [0.03, 0.035, 0.05]);
  const worldStrength = Number(spec && spec.world && spec.world.strength);
  const strength = Number.isFinite(worldStrength) ? clamp01(worldStrength / 2) : 0.4;
  const horizon = Math.round(outHeight * 0.63);
  const vignette = 0.35;
  const seed = Number(spec && spec.name ? spec.name.length : 1);

  // Fundo: gradiente vertical escuro com leve tom do world.
  for (let y = 0; y < outHeight; y += 1) {
    const t = y / outHeight;
    const tint = 0.06 + strength * 0.16;
    const r = worldColor[0] * tint * (0.4 + t) + 0.008;
    const g = worldColor[1] * tint * (0.4 + t) + 0.009;
    const b = worldColor[2] * tint * (0.4 + t) + 0.014;
    canvas.fillRect(0, y, outWidth, y + 1, [r, g, b], 1);
  }

  // Piso com perspectiva simples.
  for (let y = horizon; y < outHeight; y += 1) {
    const t = (y - horizon) / Math.max(1, outHeight - horizon);
    const shade = 0.026 + (1 - t) * 0.035;
    canvas.fillRect(0, y, outWidth, y + 1, [shade, shade * 1.05, shade * 1.12], 1);
  }
  // Linha do horizonte.
  canvas.fillRect(0, horizon - 1, outWidth, horizon + 1, [0.09, 0.1, 0.12], 0.8);

  // Grade de "estúdio": linhas verticais que convergem para o centro.
  const vanishingX = outWidth * 0.5;
  for (let i = -6; i <= 6; i += 1) {
    const xAtHorizon = vanishingX + i * (outWidth * 0.035);
    const xAtBottom = vanishingX + i * (outWidth * 0.16);
    for (let y = horizon; y < outHeight; y += 1) {
      const t = (y - horizon) / Math.max(1, outHeight - horizon);
      const x = Math.round(xAtHorizon + (xAtBottom - xAtHorizon) * t);
      canvas.set(x, y, 0.16, 0.17, 0.19, 0.22 * (1 - t));
    }
  }
  for (let i = 1; i <= 6; i += 1) {
    const t = (i / 6) ** 2;
    const y = Math.round(horizon + t * (outHeight - horizon));
    canvas.fillRect(0, y, outWidth, y + 1, [0.16, 0.17, 0.19], 0.16 * (1 - t * 0.5));
  }

  // Luzes: brilho radial colorido, intensidade derivada da energia.
  const lights = Array.isArray(spec && spec.lights) ? spec.lights.slice(0, 8) : [];
  const energySum = lights.reduce((acc, light) => acc + Math.max(0, Number(light.energy) || 0), 0) || 1;
  for (let i = 0; i < lights.length; i += 1) {
    const light = lights[i];
    const color = colorOf(light.color, [1, 1, 1]);
    const energy = Math.max(0, Number(light.energy) || 0);
    const intensity = 0.1 + 0.55 * Math.min(1, energy / energySum + 0.1);
    const px = Array.isArray(light.position) ? Number(light.position[0]) : 0;
    const py = Array.isArray(light.position) ? Number(light.position[1]) : 0;
    const cx = outWidth * 0.5 + Math.max(-1, Math.min(1, px / 8)) * outWidth * 0.34;
    const cy = outHeight * 0.28 + Math.max(-1, Math.min(1, py / 8)) * outHeight * 0.16;
    canvas.radialGlow(cx, cy, Math.max(outWidth, outHeight) * 0.22, color, intensity);
  }

  // Objetos: formas posicionadas em "palco".
  const objects = Array.isArray(spec && spec.objects) ? spec.objects.slice(0, 14) : [];
  const materials = (spec && spec.materials) || {};
  for (let i = 0; i < objects.length; i += 1) {
    const object = objects[i] || {};
    const material = object.material ? materials[object.material] : null;
    const color = colorOf(material && material.baseColor, [0.42, 0.44, 0.5]);
    const transform = object.transform || {};
    const loc = Array.isArray(transform.loc) ? transform.loc : [0, 0, 0];
    const scale = Array.isArray(transform.scale) ? transform.scale : [1, 1, 1];
    const sx = Math.abs(Number(scale[0]) || 1);
    const sy = Math.abs(Number(scale[1]) || 1);
    const sz = Math.abs(Number(scale[2]) || 1);
    const base = Math.min(outWidth, outHeight);
    const objectSize = base * (0.09 + 0.03 * Math.min(2, Math.max(sx, sy)));
    const centerX = outWidth * 0.5 + Math.max(-1, Math.min(1, Number(loc[0]) / 6)) * outWidth * 0.3;
    const centerY = horizon - Math.max(0, Number(loc[2]) || 0) * base * 0.08 + objectSize * 0.35;
    const primitive = object.primitive || (object.mesh ? 'mesh' : 'cube');
    const radiusX = objectSize * (primitive === 'plane' ? 0.9 : 0.5);
    const radiusY = objectSize * (primitive === 'plane' ? 0.16 : 0.5) * Math.max(0.3, sz);
    const shadow = [0.01, 0.01, 0.012];

    // Sombra de contato.
    canvas.fillEllipse(centerX, horizon + base * 0.02, radiusX * 1.15, radiusY * 0.4, shadow, 0.55);

    if (primitive === 'sphere' || primitive === 'torus' || primitive === 'cone') {
      canvas.fillEllipse(centerX, centerY, radiusX, Math.max(radiusX, radiusY), color, 1);
      canvas.fillEllipse(
        centerX - radiusX * 0.3,
        centerY - radiusY * 0.35,
        radiusX * 0.26,
        radiusY * 0.22,
        [1, 1, 1],
        0.22,
      );
    } else if (primitive === 'plane') {
      canvas.fillEllipse(centerX, horizon + base * 0.04, outWidth * 0.32, base * 0.06, color, 0.9);
    } else {
      canvas.fillRect(centerX - radiusX, centerY - radiusY, centerX + radiusX, centerY + radiusY, color, 1);
      canvas.fillRect(
        centerX - radiusX,
        centerY - radiusY,
        centerX + radiusX,
        centerY - radiusY + Math.max(1, radiusY * 0.16),
        [1, 1, 1],
        0.16,
      );
      canvas.fillRect(
        centerX - radiusX,
        centerY + radiusY - Math.max(1, radiusY * 0.12),
        centerX + radiusX,
        centerY + radiusY,
        [0, 0, 0],
        0.22,
      );
    }
  }

  // Vinheta e grão (determinísticos).
  for (let y = 0; y < outHeight; y += 1) {
    for (let x = 0; x < outWidth; x += 1) {
      const nx = (x - outWidth / 2) / (outWidth / 2);
      const ny = (y - outHeight / 2) / (outHeight / 2);
      const v = 1 - vignette * clamp01(Math.sqrt(nx * nx + ny * ny) ** 1.6);
      const i = (y * outWidth + x) * 4;
      const grain = (hash2d(x, y, seed) - 0.5) * 6;
      canvas.pixels[i] = Math.max(0, Math.min(255, canvas.pixels[i] * v + grain));
      canvas.pixels[i + 1] = Math.max(0, Math.min(255, canvas.pixels[i + 1] * v + grain));
      canvas.pixels[i + 2] = Math.max(0, Math.min(255, canvas.pixels[i + 2] * v + grain));
    }
  }

  return encodePNG(outWidth, outHeight, canvas.pixels);
}

module.exports = {
  PNG_SIGNATURE,
  encodePNG,
  readPNGDimensions,
  renderPlaceholder,
};
