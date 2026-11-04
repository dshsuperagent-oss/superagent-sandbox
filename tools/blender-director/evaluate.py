#!/usr/bin/env python3
"""evaluate.py — avaliação objetiva de um render contra uma referência.

Compara duas imagens e gera:

- `comparison.png` — lado a lado (referência, render, diferença amplificada e,
  quando houver máscaras, sobreposição das silhuetas);
- `report.json` — métricas, limiares, checks e limitações.

Métricas implementadas em Python puro (somente stdlib):

- **SSIM** em blocos 8x8 uniformes sobre a luminância (aproximação documentada
  da janela gaussiana 11x11 do artigo original);
- **ΔE00** (CIEDE2000) médio global e por região;
- **histograma** RGB de N caixas, com distância L1 normalizada (0..1);
- **IoU de silhueta** quando render e referência têm máscara (PNG com alpha ou
  arquivo de máscara separado). Sem máscaras, a métrica é marcada como
  indisponível — nunca inventada.

O script **falha** (exit 2) se alguma métrica disponível ficar abaixo dos
limiares configurados. Limiares são obrigatórios; o bloco `evaluation` do room
plan os carrega, ou passe `--config`.

Uso:
    python3 tools/blender-director/evaluate.py \\
        --render runs/sala/final-001.png \\
        --room tools/blender-director/examples/room-living.json \\
        --out runs/sala

    python3 tools/blender-director/evaluate.py \\
        --render render.png --reference ref.png \\
        --config tools/blender-director/examples/evaluation-living.json \\
        --out /tmp/eval

Requer Python 3.10+ (system ou o Python embutido no Blender). Não usa numpy,
Pillow, OpenCV nem rede.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import struct
import sys
import time
import zlib

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
SSIM_BLOCK = 8
METRIC_VERSION = 1

LIMITATIONS = [
    "SSIM e ΔE00 só são comparáveis com o mesmo enquadramento, resolução e exposição; notas baixas não provam, sozinhas, erro de modelagem.",
    "ΔE00 mede diferença de cor média por pixel; ela depende de iluminação, tone mapping e do próprio color management (AgX) do render.",
    "IoU de silhueta só existe quando as duas imagens têm máscara; ele ignora textura, cor e detalhe interno.",
    "Histograma compara distribuição de cor; duas cenas diferentes podem ter histogramas parecidos.",
    "A comparação usa a resolução do render; a referência é redimensionada se necessário, o que suaviza detalhes.",
    "Nenhuma métrica prova fotorrealismo absoluto: elas medem aderência mensurável a uma referência específica.",
]


# ---------------------------------------------------------------------------
# PNG (decodificador/encoder stdlib)
# ---------------------------------------------------------------------------


class Image:
    __slots__ = ("width", "height", "rgb", "alpha", "path", "sha256")

    def __init__(self, width, height, rgb, alpha=None, path=None, sha256=None):
        self.width = int(width)
        self.height = int(height)
        self.rgb = rgb
        self.alpha = alpha
        self.path = path
        self.sha256 = sha256

    def pixel(self, x, y):
        index = (y * self.width + x) * 3
        return self.rgb[index], self.rgb[index + 1], self.rgb[index + 2]


def _paeth(a, b, c):
    p = a + b - c
    pa = abs(p - a)
    pb = abs(p - b)
    pc = abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    if pb <= pc:
        return b
    return c


def _channels(color_type):
    return {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color_type]


def decode_png(path):
    with open(path, "rb") as handle:
        data = handle.read()
    if not data.startswith(PNG_SIGNATURE):
        raise ValueError(f"{path}: não é um PNG")
    sha = hashlib.sha256(data).hexdigest()
    position = 8
    width = height = None
    bit_depth = color_type = interlace = None
    palette = None
    transparency = None
    idat = []
    while position < len(data):
        length = struct.unpack(">I", data[position:position + 4])[0]
        chunk_type = data[position + 4:position + 8]
        chunk = data[position + 8:position + 8 + length]
        position += 12 + length
        if chunk_type == b"IHDR":
            width, height, bit_depth, color_type, compression, filter_method, interlace = struct.unpack(">IIBBBBB", chunk)
            if compression != 0 or filter_method != 0:
                raise ValueError(f"{path}: compressão/filtro PNG não suportados")
            if interlace != 0:
                raise ValueError(f"{path}: PNG entrelaçado não é suportado; exporte sem interlace")
        elif chunk_type == b"PLTE":
            palette = chunk
        elif chunk_type == b"tRNS":
            transparency = chunk
        elif chunk_type == b"IDAT":
            idat.append(chunk)
        elif chunk_type == b"IEND":
            break
    if width is None or height is None or color_type is None:
        raise ValueError(f"{path}: IHDR ausente")
    if color_type not in (0, 2, 3, 4, 6):
        raise ValueError(f"{path}: tipo de cor PNG não suportado ({color_type})")
    if bit_depth not in (8, 16) and not (color_type == 3 and bit_depth in (1, 2, 4, 8)):
        raise ValueError(f"{path}: profundidade {bit_depth} não suportada (use PNG 8/16 bits)")
    channels = _channels(color_type)
    bytes_per_pixel = max(1, channels * (bit_depth // 8))
    stride = width * channels * (bit_depth // 8)
    raw = zlib.decompress(b"".join(idat))
    expected = (stride + 1) * height
    if len(raw) < expected:
        raise ValueError(f"{path}: dados IDAT truncados ({len(raw)} < {expected})")
    recon = bytearray(stride * height)
    previous = bytearray(stride)
    position = 0
    for y in range(height):
        filter_type = raw[position]
        position += 1
        line = raw[position:position + stride]
        position += stride
        current = bytearray(stride)
        if filter_type == 0:
            current[:] = line
        elif filter_type == 1:
            for i in range(stride):
                left = current[i - bytes_per_pixel] if i >= bytes_per_pixel else 0
                current[i] = (line[i] + left) & 0xFF
        elif filter_type == 2:
            for i in range(stride):
                current[i] = (line[i] + previous[i]) & 0xFF
        elif filter_type == 3:
            for i in range(stride):
                left = current[i - bytes_per_pixel] if i >= bytes_per_pixel else 0
                up = previous[i]
                current[i] = (line[i] + ((left + up) >> 1)) & 0xFF
        elif filter_type == 4:
            for i in range(stride):
                left = current[i - bytes_per_pixel] if i >= bytes_per_pixel else 0
                up = previous[i]
                up_left = previous[i - bytes_per_pixel] if i >= bytes_per_pixel else 0
                current[i] = (line[i] + _paeth(left, up, up_left)) & 0xFF
        else:
            raise ValueError(f"{path}: filtro PNG desconhecido {filter_type}")
        recon[y * stride:(y + 1) * stride] = current
        previous = current

    rgb = bytearray(width * height * 3)
    alpha = bytearray(b"\xff" * (width * height))
    step = bit_depth // 8
    for y in range(height):
        row = y * stride
        target = y * width * 3
        for x in range(width):
            offset = row + x * channels * step
            if bit_depth == 16:
                values = [recon[offset + index * 2] for index in range(channels)]
            else:
                values = [recon[offset + index] for index in range(channels)]
            if color_type == 0:
                r = g = b = values[0]
            elif color_type == 2:
                r, g, b = values[0], values[1], values[2]
            elif color_type == 4:
                r = g = b = values[0]
                alpha[y * width + x] = values[1]
            elif color_type == 6:
                r, g, b = values[0], values[1], values[2]
                alpha[y * width + x] = values[3]
            else:  # palette
                if palette is None:
                    raise ValueError(f"{path}: PNG com paleta e sem PLTE")
                index = recon[row + x] if bit_depth == 8 else (recon[row + x // (8 // bit_depth)] >> (8 - bit_depth * ((x % (8 // bit_depth)) + 1))) & ((1 << bit_depth) - 1)
                r, g, b = palette[index * 3], palette[index * 3 + 1], palette[index * 3 + 2]
                if transparency is not None and index < len(transparency):
                    alpha[y * width + x] = transparency[index]
            rgb[target + x * 3] = r
            rgb[target + x * 3 + 1] = g
            rgb[target + x * 3 + 2] = b
    if all(value == 255 for value in alpha):
        alpha = None
    return Image(width, height, bytes(rgb), None if alpha is None else bytes(alpha), path, sha)


def encode_png(width, height, rgb):
    stride = width * 3
    if len(rgb) != stride * height:
        raise ValueError("buffer RGB com tamanho inesperado")
    raw = bytearray()
    for y in range(height):
        raw.append(0)
        raw.extend(rgb[y * stride:(y + 1) * stride])

    def chunk(chunk_type, payload):
        return (
            struct.pack(">I", len(payload))
            + chunk_type
            + payload
            + struct.pack(">I", zlib.crc32(chunk_type + payload) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return PNG_SIGNATURE + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(bytes(raw), 6)) + chunk(b"IEND", b"")


def write_png(path, width, height, rgb):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(encode_png(width, height, rgb))


def load_mask(path, width, height):
    image = decode_png(path)
    mask = bytearray(width * height)
    if image.alpha is not None:
        for y in range(height):
            source_y = min(image.height - 1, int(y * image.height / height))
            for x in range(width):
                source_x = min(image.width - 1, int(x * image.width / width))
                mask[y * width + x] = 1 if image.alpha[source_y * image.width + source_x] > 127 else 0
    else:
        for y in range(height):
            source_y = min(image.height - 1, int(y * image.height / height))
            for x in range(width):
                source_x = min(image.width - 1, int(x * image.width / width))
                index = (source_y * image.width + source_x) * 3
                luma = 0.2126 * image.rgb[index] + 0.7152 * image.rgb[index + 1] + 0.0722 * image.rgb[index + 2]
                mask[y * width + x] = 1 if luma > 127 else 0
    return mask


# ---------------------------------------------------------------------------
# Reamostragem
# ---------------------------------------------------------------------------


def resize_bilinear(image, width, height):
    if image.width == width and image.height == height:
        return Image(width, height, image.rgb, image.alpha, image.path, image.sha256)
    source = image.rgb
    source_width, source_height = image.width, image.height
    target = bytearray(width * height * 3)
    x_scale = source_width / width
    y_scale = source_height / height
    for y in range(height):
        sy = min(source_height - 1.0, (y + 0.5) * y_scale - 0.5)
        y0 = int(math.floor(sy))
        y1 = min(source_height - 1, y0 + 1)
        wy = sy - y0
        row0 = y0 * source_width
        row1 = y1 * source_width
        for x in range(width):
            sx = min(source_width - 1.0, (x + 0.5) * x_scale - 0.5)
            x0 = int(math.floor(sx))
            x1 = min(source_width - 1, x0 + 1)
            wx = sx - x0
            i00 = (row0 + x0) * 3
            i01 = (row0 + x1) * 3
            i10 = (row1 + x0) * 3
            i11 = (row1 + x1) * 3
            out = (y * width + x) * 3
            for channel in range(3):
                top = source[i00 + channel] * (1 - wx) + source[i01 + channel] * wx
                bottom = source[i10 + channel] * (1 - wx) + source[i11 + channel] * wx
                target[out + channel] = int(round(top * (1 - wy) + bottom * wy))
    alpha = None
    if image.alpha is not None:
        alpha = bytearray(width * height)
        for y in range(height):
            sy = min(source_height - 1, int(y * source_height / height))
            for x in range(width):
                sx = min(source_width - 1, int(x * source_width / width))
                alpha[y * width + x] = image.alpha[sy * source_width + sx]
    return Image(width, height, bytes(target), None if alpha is None else bytes(alpha), image.path, image.sha256)


def resize_mask(mask, source_width, source_height, width, height):
    target = bytearray(width * height)
    for y in range(height):
        sy = min(source_height - 1, int(y * source_height / height))
        for x in range(width):
            sx = min(source_width - 1, int(x * source_width / width))
            target[y * width + x] = mask[sy * source_width + sx]
    return target


# ---------------------------------------------------------------------------
# Cor e métricas
# ---------------------------------------------------------------------------


def srgb_to_linear(value):
    value /= 255.0
    return value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4


def linear_to_xyz(r, g, b):
    return (
        0.4124564 * r + 0.3575761 * g + 0.1804375 * b,
        0.2126729 * r + 0.7151522 * g + 0.0721750 * b,
        0.0193339 * r + 0.1191920 * g + 0.9503041 * b,
    )


def xyz_to_lab(x, y, z):
    white = (0.95047, 1.0, 1.08883)

    def f(value):
        delta = 6 / 29
        return value ** (1 / 3) if value > delta ** 3 else value / (3 * delta ** 2) + 4 / 29

    fx = f(x / white[0])
    fy = f(y / white[1])
    fz = f(z / white[2])
    return (116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz))


def rgb_to_lab(r, g, b):
    return xyz_to_lab(*linear_to_xyz(srgb_to_linear(r), srgb_to_linear(g), srgb_to_linear(b)))


def delta_e_2000(lab1, lab2):
    """CIEDE2000 com kL=kC=kH=1 (Sharma et al., 2005)."""
    l1, a1, b1 = lab1
    l2, a2, b2 = lab2
    c1 = math.hypot(a1, b1)
    c2 = math.hypot(a2, b2)
    c_bar = (c1 + c2) / 2
    g = 0.5 * (1 - math.sqrt(c_bar ** 7 / (c_bar ** 7 + 25 ** 7))) if c_bar > 0 else 0.5
    a1p = (1 + g) * a1
    a2p = (1 + g) * a2
    c1p = math.hypot(a1p, b1)
    c2p = math.hypot(a2p, b2)
    h1p = math.degrees(math.atan2(b1, a1p)) % 360 if (a1p or b1) else 0.0
    h2p = math.degrees(math.atan2(b2, a2p)) % 360 if (a2p or b2) else 0.0
    delta_l = l2 - l1
    delta_c = c2p - c1p
    if c1p * c2p == 0:
        delta_h = 0.0
    else:
        difference = h2p - h1p
        if difference > 180:
            difference -= 360
        elif difference < -180:
            difference += 360
        delta_h = 2 * math.sqrt(c1p * c2p) * math.sin(math.radians(difference / 2))
    l_bar = (l1 + l2) / 2
    c_bar_p = (c1p + c2p) / 2
    if c1p * c2p == 0:
        h_bar = h1p + h2p
    elif abs(h1p - h2p) <= 180:
        h_bar = (h1p + h2p) / 2
    elif h1p + h2p < 360:
        h_bar = (h1p + h2p + 360) / 2
    else:
        h_bar = (h1p + h2p - 360) / 2
    t = (
        1
        - 0.17 * math.cos(math.radians(h_bar - 30))
        + 0.24 * math.cos(math.radians(2 * h_bar))
        + 0.32 * math.cos(math.radians(3 * h_bar + 6))
        - 0.20 * math.cos(math.radians(4 * h_bar - 63))
    )
    delta_theta = 30 * math.exp(-(((h_bar - 275) / 25) ** 2))
    r_c = 2 * math.sqrt(c_bar_p ** 7 / (c_bar_p ** 7 + 25 ** 7)) if c_bar_p > 0 else 0
    s_l = 1 + 0.015 * (l_bar - 50) ** 2 / math.sqrt(20 + (l_bar - 50) ** 2)
    s_c = 1 + 0.045 * c_bar_p
    s_h = 1 + 0.015 * c_bar_p * t
    r_t = -math.sin(math.radians(2 * delta_theta)) * r_c
    return math.sqrt(
        (delta_l / s_l) ** 2
        + (delta_c / s_c) ** 2
        + (delta_h / s_h) ** 2
        + r_t * (delta_c / s_c) * (delta_h / s_h)
    )


def luma(r, g, b):
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255.0


def downsample(image, max_size):
    if max(image.width, image.height) <= max_size:
        return image, False
    scale = max_size / max(image.width, image.height)
    width = max(1, int(round(image.width * scale)))
    height = max(1, int(round(image.height * scale)))
    return resize_bilinear(image, width, height), True


def ssim_gray(gray_a, gray_b, width, height, block=SSIM_BLOCK):
    total_weight = 0
    total = 0.0
    c1 = 0.01 ** 2
    c2 = 0.03 ** 2
    for block_y in range(0, height, block):
        for block_x in range(0, width, block):
            count = 0
            sum_x = sum_y = sum_xx = sum_yy = sum_xy = 0.0
            for y in range(block_y, min(height, block_y + block)):
                row = y * width
                for x in range(block_x, min(width, block_x + block)):
                    value_a = gray_a[row + x]
                    value_b = gray_b[row + x]
                    count += 1
                    sum_x += value_a
                    sum_y += value_b
                    sum_xx += value_a * value_a
                    sum_yy += value_b * value_b
                    sum_xy += value_a * value_b
            if count == 0:
                continue
            mean_x = sum_x / count
            mean_y = sum_y / count
            var_x = sum_xx / count - mean_x * mean_x
            var_y = sum_yy / count - mean_y * mean_y
            cov = sum_xy / count - mean_x * mean_y
            numerator = (2 * mean_x * mean_y + c1) * (2 * cov + c2)
            denominator = (mean_x * mean_x + mean_y * mean_y + c1) * (var_x + var_y + c2)
            total += count * (numerator / denominator if denominator else 1.0)
            total_weight += count
    return total / total_weight if total_weight else 0.0


def grayscale(image):
    values = [0.0] * (image.width * image.height)
    for index in range(image.width * image.height):
        values[index] = luma(image.rgb[index * 3], image.rgb[index * 3 + 1], image.rgb[index * 3 + 2])
    return values


def delta_e_map(image_a, image_b):
    values = [0.0] * (image_a.width * image_a.height)
    for index in range(image_a.width * image_a.height):
        a = (image_a.rgb[index * 3], image_a.rgb[index * 3 + 1], image_a.rgb[index * 3 + 2])
        b = (image_b.rgb[index * 3], image_b.rgb[index * 3 + 1], image_b.rgb[index * 3 + 2])
        values[index] = delta_e_2000(rgb_to_lab(*a), rgb_to_lab(*b))
    return values


def histogram(image, bins):
    channels = [[0] * bins for _ in range(3)]
    total = image.width * image.height
    for index in range(total):
        for channel in range(3):
            value = image.rgb[index * 3 + channel]
            bucket = min(bins - 1, value * bins // 256)
            channels[channel][bucket] += 1
    return [[count / total for count in channel] for channel in channels]


def histogram_distance(hist_a, hist_b):
    distance = 0.0
    for channel in range(3):
        distance += 0.5 * sum(abs(a - b) for a, b in zip(hist_a[channel], hist_b[channel]))
    return distance / 3.0


def iou(mask_a, mask_b):
    intersection = 0
    union = 0
    for a, b in zip(mask_a, mask_b):
        if a or b:
            union += 1
            if a and b:
                intersection += 1
    return (intersection / union) if union else 1.0, intersection, union


def region_pixels(region, width, height):
    x, y, w, h = region["rect"]
    x0 = max(0, min(width - 1, int(round(x * width))))
    y0 = max(0, min(height - 1, int(round(y * height))))
    x1 = max(x0 + 1, min(width, int(round((x + w) * width))))
    y1 = max(y0 + 1, min(height, int(round((y + h) * height))))
    return x0, y0, x1, y1


def region_metrics(region, gray_a, gray_b, delta_map, width, height):
    x0, y0, x1, y1 = region_pixels(region, width, height)
    count = (x1 - x0) * (y1 - y0)
    delta_sum = 0.0
    luma_sum = 0.0
    for y in range(y0, y1):
        row = y * width
        for x in range(x0, x1):
            delta_sum += delta_map[row + x]
            luma_sum += gray_b[row + x]
    crop_width = x1 - x0
    crop_height = y1 - y0
    crop_a = [0.0] * (crop_width * crop_height)
    crop_b = [0.0] * (crop_width * crop_height)
    for y in range(crop_height):
        source = (y0 + y) * width + x0
        target = y * crop_width
        crop_a[target:target + crop_width] = gray_a[source:source + crop_width]
        crop_b[target:target + crop_width] = gray_b[source:source + crop_width]
    return {
        "ssim": ssim_gray(crop_a, crop_b, crop_width, crop_height),
        "deltaE00": delta_sum / count if count else 0.0,
        "luminance": luma_sum / count if count else 0.0,
        "pixels": count,
    }


# ---------------------------------------------------------------------------
# Imagem de comparação
# ---------------------------------------------------------------------------


def scale_for_panel(image, max_width):
    if image.width <= max_width:
        return image
    scale = max_width / image.width
    return resize_bilinear(image, max_width, max(1, int(round(image.height * scale))))


def draw_rect(rgb, width, height, rect, color):
    x0, y0, x1, y1 = rect
    for y in range(y0, y1):
        for x in range(x0, x1):
            if x < 0 or y < 0 or x >= width or y >= height:
                continue
            index = (y * width + x) * 3
            rgb[index] = color[0]
            rgb[index + 1] = color[1]
            rgb[index + 2] = color[2]


def make_comparison(reference, render, regions, render_mask, reference_mask, path, panel_width=480):
    panels_reference = scale_for_panel(reference, panel_width)
    panels_render = scale_for_panel(render, panel_width)
    height = min(panels_reference.height, panels_render.height)
    reference_panel = resize_bilinear(panels_reference, panels_reference.width, height)
    render_panel = resize_bilinear(panels_render, panels_render.width, height)
    difference = Image(reference_panel.width, reference_panel.height, bytes(reference_panel.width * height * 3))
    difference.rgb = bytearray(difference.rgb)
    for index in range(reference_panel.width * height):
        for channel in range(3):
            value = abs(reference_panel.rgb[index * 3 + channel] - render_panel.rgb[index * 3 + channel])
            difference.rgb[index * 3 + channel] = min(255, value * 3)
    panels = [
        ("reference", reference_panel),
        ("render", render_panel),
        ("difference", Image(difference.width, difference.height, bytes(difference.rgb))),
    ]
    if render_mask is not None and reference_mask is not None:
        mask_panel = Image(render_panel.width, render_panel.height, bytes(render_panel.width * height * 3))
        mask_panel.rgb = bytearray(mask_panel.rgb)
        for index in range(render_panel.width * height):
            a = render_mask[index] if index < len(render_mask) else 0
            b = reference_mask[index] if index < len(reference_mask) else 0
            mask_panel.rgb[index * 3] = 255 if a else 0
            mask_panel.rgb[index * 3 + 1] = 255 if b else 0
            mask_panel.rgb[index * 3 + 2] = 0
        panels.append(("masks", mask_panel))
    gap = 6
    background = (18, 18, 18)
    total_width = sum(panel.width for _, panel in panels) + gap * (len(panels) - 1)
    canvas = bytearray(b"".join([bytes(background)] * (total_width * height)))
    offsets = [0, 0, 0, 0]
    offset = 0
    for index, (name, panel) in enumerate(panels):
        offsets[index] = offset
        for y in range(height):
            source = y * panel.width * 3
            target = (y * total_width + offset) * 3
            canvas[target:target + panel.width * 3] = panel.rgb[source:source + panel.width * 3]
        offset += panel.width + gap
    for region in regions:
        x, y, w, h = region["rect"]
        for index in (0, 1):
            panel = panels[index][1]
            left = offsets[index] + int(round(x * panel.width))
            top = int(round(y * height))
            right = offsets[index] + int(round((x + w) * panel.width))
            bottom = int(round((y + h) * height))
            draw_rect(canvas, total_width, height, (left, top, right, top + 2), (255, 212, 0))
            draw_rect(canvas, total_width, height, (left, bottom - 2, right, bottom), (255, 212, 0))
            draw_rect(canvas, total_width, height, (left, top, left + 2, bottom), (255, 212, 0))
            draw_rect(canvas, total_width, height, (right - 2, top, right, bottom), (255, 212, 0))
    write_png(path, total_width, height, bytes(canvas))
    return {"path": path, "width": total_width, "height": height, "panels": [name for name, _ in panels], "regionRects": len(regions)}


# ---------------------------------------------------------------------------
# Relatório
# ---------------------------------------------------------------------------


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def load_room_evaluation(room_path):
    with open(room_path, "r", encoding="utf-8") as handle:
        plan = json.load(handle)
    evaluation = plan.get("evaluation")
    if not isinstance(evaluation, dict):
        raise ValueError(f"{room_path}: room plan sem bloco evaluation")
    base = os.path.dirname(os.path.abspath(room_path))

    def resolve(value):
        if value is None:
            return None
        return value if os.path.isabs(value) else os.path.normpath(os.path.join(base, value))

    return {
        "room": os.path.abspath(room_path),
        "reference": resolve(evaluation.get("reference")),
        "referenceMask": resolve(evaluation.get("referenceMask")),
        "requireMasks": bool(evaluation.get("requireMasks", False)),
        "regions": evaluation.get("regions") or [],
        "thresholds": evaluation.get("thresholds"),
        "histogramBins": int(evaluation.get("histogramBins", 16)),
        "maxEvalSize": int(evaluation.get("maxEvalSize", 512)),
        "notes": evaluation.get("notes"),
    }


def load_config(config_path):
    with open(config_path, "r", encoding="utf-8") as handle:
        config = json.load(handle)
    base = os.path.dirname(os.path.abspath(config_path))

    def resolve(value):
        if value is None:
            return None
        return value if os.path.isabs(value) else os.path.normpath(os.path.join(base, value))

    return {
        "room": config.get("room"),
        "reference": resolve(config.get("reference")),
        "referenceMask": resolve(config.get("referenceMask")),
        "requireMasks": bool(config.get("requireMasks", False)),
        "regions": config.get("regions") or [],
        "thresholds": config.get("thresholds"),
        "histogramBins": int(config.get("histogramBins", 16)),
        "maxEvalSize": int(config.get("maxEvalSize", 512)),
        "notes": config.get("notes"),
    }


def check_thresholds(metrics, regions, thresholds, require_masks, masks_available):
    checks = []

    def add(metric, value, threshold, operation):
        if value is None:
            return
        passed = value >= threshold if operation == ">=" else value <= threshold
        checks.append({"metric": metric, "value": value, "threshold": threshold, "op": operation, "pass": bool(passed)})

    add("ssim", metrics["ssim"], thresholds["ssimMin"], ">=")
    add("deltaE00", metrics["deltaE00"], thresholds["deltaE00Max"], "<=")
    add("histogram", metrics["histogram"]["distance"], thresholds["histogramMax"], "<=")
    if regions:
        worst = max(region["metrics"]["deltaE00"] for region in regions)
        add("deltaE00_region_max", worst, thresholds["deltaE00RegionMax"], "<=")
    if masks_available:
        add("iou", metrics["iou"]["value"], thresholds["iouMin"], ">=")
    elif require_masks:
        checks.append({
            "metric": "iou",
            "value": None,
            "threshold": thresholds["iouMin"],
            "op": ">=",
            "pass": False,
            "reason": "máscaras de silhueta exigidas, mas não fornecidas",
        })
    return checks


def evaluate(render_path, reference_path, out_dir, config, render_mask_path=None, reference_mask_path=None,
             resize_policy="fit", verbose=True):
    started = time.time()
    render = decode_png(render_path)
    reference = decode_png(reference_path)
    metrics_config = {
        "maxEvalSize": config["maxEvalSize"],
        "histogramBins": config["histogramBins"],
        "regions": config["regions"],
        "thresholds": config["thresholds"],
        "requireMasks": config["requireMasks"],
    }
    if config["thresholds"] is None:
        raise ValueError("limiares ausentes: configure evaluation.thresholds no room plan ou --config")

    resized_reference = False
    if render.width != reference.width or render.height != reference.height:
        if resize_policy == "error":
            raise ValueError(
                f"render {render.width}x{render.height} e referência {reference.width}x{reference.height} têm tamanhos diferentes "
                "(use --resize fit ou gere o render no mesmo enquadramento)"
            )
        reference = resize_bilinear(reference, render.width, render.height)
        resized_reference = True

    eval_render, downsampled = downsample(render, config["maxEvalSize"])
    eval_reference, _ = downsample(reference, config["maxEvalSize"])
    if eval_render.width != eval_reference.width or eval_render.height != eval_reference.height:
        eval_reference = resize_bilinear(eval_reference, eval_render.width, eval_render.height)
    width, height = eval_render.width, eval_render.height

    gray_render = grayscale(eval_render)
    gray_reference = grayscale(eval_reference)
    delta_map = delta_e_map(eval_reference, eval_render)
    ssim_value = ssim_gray(gray_reference, gray_render, width, height)
    delta_mean = sum(delta_map) / len(delta_map)

    hist_reference = histogram(eval_reference, config["histogramBins"])
    hist_render = histogram(eval_render, config["histogramBins"])
    hist_distance = histogram_distance(hist_reference, hist_render)

    regions = []
    for region in config["regions"]:
        measurement = region_metrics(region, gray_reference, gray_render, delta_map, width, height)
        regions.append({
            "id": region.get("id", "regiao"),
            "label": region.get("label", region.get("id", "regiao")),
            "rect": region.get("rect"),
            "metrics": {
                "ssim": round(measurement["ssim"], 6),
                "deltaE00": round(measurement["deltaE00"], 4),
                "luminance": round(measurement["luminance"], 6),
                "pixels": measurement["pixels"],
            },
        })

    mask_source_render = render_mask_path or (render_path if render.alpha is not None else None)
    mask_source_reference = reference_mask_path or (reference_path if reference.alpha is not None else None)
    masks = {"render": None, "reference": None, "available": False, "reason": None}
    iou_value = None
    if mask_source_render and mask_source_reference:
        render_mask_full = load_mask(mask_source_render, render.width, render.height)
        reference_mask_full = load_mask(mask_source_reference, render.width, render.height)
        render_mask_eval = resize_mask(render_mask_full, render.width, render.height, width, height)
        reference_mask_eval = resize_mask(reference_mask_full, render.width, render.height, width, height)
        iou_value, intersection, union = iou(render_mask_eval, reference_mask_eval)
        masks.update({
            "render": os.path.abspath(mask_source_render),
            "reference": os.path.abspath(mask_source_reference),
            "available": True,
            "iou": round(iou_value, 6),
            "intersection": intersection,
            "union": union,
            "coverageRender": round(sum(render_mask_eval) / len(render_mask_eval), 6),
            "coverageReference": round(sum(reference_mask_eval) / len(reference_mask_eval), 6),
        })
    else:
        missing = []
        if not mask_source_render:
            missing.append("render (sem alpha e sem --render-mask)")
        if not mask_source_reference:
            missing.append("referência (sem alpha e sem --reference-mask)")
        masks["reason"] = "máscara ausente para: " + "; ".join(missing)

    metrics = {
        "ssim": round(ssim_value, 6),
        "deltaE00": round(delta_mean, 4),
        "histogram": {
            "distance": round(hist_distance, 6),
            "bins": config["histogramBins"],
            "reference": [[round(value, 6) for value in channel] for channel in hist_reference],
            "render": [[round(value, 6) for value in channel] for channel in hist_render],
        },
        "iou": {
            "value": None if iou_value is None else round(iou_value, 6),
            "available": masks["available"],
            "reason": masks["reason"],
        },
    }
    checks = check_thresholds(metrics, regions, config["thresholds"], config["requireMasks"], masks["available"])
    verdict = "pass" if all(check["pass"] for check in checks) and checks else "fail"
    if not checks:
        verdict = "fail"

    os.makedirs(out_dir, exist_ok=True)
    comparison_path = os.path.join(out_dir, "comparison.png")
    # A imagem de comparação usa as máscaras em tamanho de painel.
    comparison_masks = None
    if masks["available"]:
        panel_width = min(480, render.width)
        panel_height = max(1, int(round(render.height * panel_width / render.width)))
        comparison_masks = (
            load_mask(mask_source_render, panel_width, panel_height),
            load_mask(mask_source_reference, panel_width, panel_height),
        )
    comparison = make_comparison(
        reference,
        render,
        config["regions"],
        comparison_masks[0] if comparison_masks else None,
        comparison_masks[1] if comparison_masks else None,
        comparison_path,
    )

    report = {
        "schemaVersion": METRIC_VERSION,
        "generator": "blender-director/evaluate.py",
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "verdict": verdict,
        "inputs": {
            "render": {
                "path": os.path.abspath(render_path),
                "width": render.width,
                "height": render.height,
                "sha256": render.sha256 or sha256_file(render_path),
            },
            "reference": {
                "path": os.path.abspath(reference_path),
                "width": reference.width,
                "height": reference.height,
                "sha256": reference.sha256 or sha256_file(reference_path),
                "resizedToRender": resized_reference,
            },
            "masks": {key: masks[key] for key in ("render", "reference")},
        },
        "geometry": {
            "comparedAt": [width, height],
            "downsampled": downsampled,
            "maxEvalSize": config["maxEvalSize"],
            "ssimBlock": SSIM_BLOCK,
        },
        "metrics": metrics,
        "regions": regions,
        "thresholds": config["thresholds"],
        "checks": checks,
        "masks": masks,
        "comparison": comparison,
        "limitations": LIMITATIONS,
        "notes": config.get("notes"),
        "config": {"room": config.get("room")},
        "elapsedSeconds": None,
    }
    report["elapsedSeconds"] = round(time.time() - started, 3)
    report_path = os.path.join(out_dir, "report.json")
    with open(report_path, "w", encoding="utf-8") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2)
        handle.write("\n")

    if verbose:
        print(f"render:    {render.width}x{render.height}  {os.path.abspath(render_path)}")
        print(f"reference: {reference.width}x{reference.height}  {os.path.abspath(reference_path)}")
        print(f"SSIM:      {metrics['ssim']:.4f}  (mínimo {config['thresholds']['ssimMin']})")
        print(f"ΔE00:      {metrics['deltaE00']:.2f}  (máximo {config['thresholds']['deltaE00Max']})")
        print(f"histogram: {metrics['histogram']['distance']:.4f}  (máximo {config['thresholds']['histogramMax']})")
        for region in regions:
            print(f"  região {region['label']:<24} ΔE00 {region['metrics']['deltaE00']:6.2f}  SSIM {region['metrics']['ssim']:.3f}")
        if masks["available"]:
            print(f"IoU:       {metrics['iou']['value']:.4f}  (mínimo {config['thresholds']['iouMin']})")
        else:
            print(f"IoU:       indisponível ({masks['reason']})")
        for check in checks:
            if not check["pass"]:
                print(f"  FALHOU: {check['metric']} = {check['value']} (limiar {check['op']} {check['threshold']})")
        print(f"resultado: {verdict.upper()}")
        print(f"comparison: {comparison_path}")
        print(f"report:     {report_path}")
    return report, 0 if verdict == "pass" else 2


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def parse_args(argv):
    parser = argparse.ArgumentParser(description="Avalia um render contra uma referência (IoU, SSIM, ΔE00, histograma).")
    parser.add_argument("--render", required=True, help="PNG do render")
    parser.add_argument("--reference", help="PNG da referência (ou use --room/--config)")
    parser.add_argument("--room", help="room plan com o bloco evaluation")
    parser.add_argument("--config", help="JSON de avaliação {reference, regions, thresholds, ...}")
    parser.add_argument("--out", help="diretório de saída (padrão: diretório do render)")
    parser.add_argument("--render-mask", help="PNG de máscara do render (alpha ou tons de cinza)")
    parser.add_argument("--reference-mask", help="PNG de máscara da referência")
    parser.add_argument("--resize", choices=["fit", "error"], default="fit", help="o que fazer se os tamanhos diferirem")
    parser.add_argument("--json", action="store_true", help="imprime o report.json no stdout")
    parser.add_argument("--quiet", action="store_true", help="não imprime o resumo humano")
    return parser.parse_args(argv)


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    args = parse_args(argv)
    if args.config:
        config = load_config(args.config)
    elif args.room:
        config = load_room_evaluation(args.room)
    else:
        print("erro: informe --room ou --config (os limiares são obrigatórios)", file=sys.stderr)
        return 1
    if args.reference:
        config["reference"] = os.path.abspath(args.reference)
    if not config.get("reference"):
        print("erro: referência ausente; use --reference ou evaluation.reference no room plan", file=sys.stderr)
        return 1
    out_dir = args.out or os.path.dirname(os.path.abspath(args.render))
    try:
        report, code = evaluate(
            args.render,
            config["reference"],
            out_dir,
            config,
            render_mask_path=args.render_mask,
            reference_mask_path=args.reference_mask or config.get("referenceMask"),
            resize_policy=args.resize,
            verbose=not args.quiet,
        )
    except (OSError, ValueError) as error:
        print(f"erro: {error}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    return code


if __name__ == "__main__":
    sys.exit(main())
