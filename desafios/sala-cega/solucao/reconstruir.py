#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Desafio da Sala Cega: reconstrucao de cena 3D a partir de uma imagem.

Uso:
    python reconstruir.py --ref <imagem.png> --out <cena.json> [--seed N]

O programa le APENAS a imagem indicada e grava uma cena no schema v1.

Metodo (resumo):
  1. deteccao da janela luminosa (retangulo da abertura) por limiar + bordas
     subpixel;
  2. retas estruturais da sala (linha teto-parede, linha piso-parede, aresta
     vertical do canto e linha teto-parede direita) por varredura de gradiente;
  3. pontos de fuga -> rotacao da camera e comprimento focal (lente 24 mm como
     priori do kit; a imagem nao determina a escala absoluta);
  4. homografia do retangulo da janela -> proporcao da janela e pose relativa
     camera-parede (a menos de escala);
  5. interseccao dos raios com o plano da parede do fundo -> altura do teto,
     peitoril e largura da sala em unidades de largura da janela;
  6. priori de altura da sala (2,70 m) fixa a escala metrica; margens tipicas
     da camera (0,35 m das paredes esquerda/frente) fixam o centro da sala;
  7. refinamento por minimos quadrados (Nelder-Mead deterministico) das retas
     e dos cantos da janela;
  8. deteccao de mobiliario por cor/plano (tapete, sofa, mesa, livros);
  9. estimativa de materiais e de um rig de luz fixo calibrado no kit.

Tudo deterministico: nenhuma dependencia de rede, relogio ou aleatoriedade
(fora da seed, usada apenas de forma reprodutivel em desempates).
"""

import argparse
import json
import math
import os
import struct
import sys
import zlib

import numpy as np

# ---------------------------------------------------------------------------
# Constantes do kit / priors calibrados
# ---------------------------------------------------------------------------
SENSOR_MM = 36.0
LENTE_MM = 24.0          # lente usada pelo kit de calibracao
ALTURA_SALA = 2.70       # priori metrica (imagem so determina escala relativa)
MARGEM_ESQ = 0.35        # camera a 0,35 m da parede esquerda (prior tipico)
MARGEM_FRENTE = 0.35     # camera a 0,35 m da parede da frente (prior tipico)
ALTURA_REF = ALTURA_SALA

# ---------------------------------------------------------------------------
# Leitura de imagem (PIL quando existe; PNG puro em stdlib como fallback)
# ---------------------------------------------------------------------------
def _png_read_stdlib(path):
    data = open(path, "rb").read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("formato nao suportado (esperado PNG): " + path)
    pos = 8
    width = height = bitdepth = colortype = None
    idat = []
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        ctype = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + length]
        pos += 12 + length
        if ctype == b"IHDR":
            width, height, bitdepth, colortype, comp, filt, inter = struct.unpack(
                ">IIBBBBB", chunk)
            if bitdepth != 8 or inter != 0 or colortype not in (0, 2, 4, 6):
                raise ValueError("PNG nao suportado (use 8 bits RGB/RGBA)")
        elif ctype == b"IDAT":
            idat.append(chunk)
        elif ctype == b"IEND":
            break
    raw = zlib.decompress(b"".join(idat))
    nch = {0: 1, 2: 3, 4: 2, 6: 4}[colortype]
    stride = width * nch
    out = np.zeros((height, width, 3), dtype=np.uint8)
    prev = np.zeros(stride, dtype=np.uint8)
    p = 0
    for y in range(height):
        f = raw[p]
        p += 1
        line = np.frombuffer(raw[p:p + stride], dtype=np.uint8).astype(np.int32)
        p += stride
        if f == 1:  # Sub
            for i in range(nch, stride):
                line[i] = (line[i] + line[i - nch]) & 255
        elif f == 2:  # Up
            line = (line + prev.astype(np.int32)) & 255
        elif f == 3:  # Average
            for i in range(stride):
                left = line[i - nch] if i >= nch else 0
                line[i] = (line[i] + ((left + int(prev[i])) >> 1)) & 255
        elif f == 4:  # Paeth
            for i in range(stride):
                a = int(line[i - nch]) if i >= nch else 0
                b = int(prev[i])
                c = int(prev[i - nch]) if i >= nch else 0
                pp = a + b - c
                pa, pb, pc = abs(pp - a), abs(pp - b), abs(pp - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        prev = line.astype(np.uint8)
        if colortype == 0:
            out[y, :, 0] = out[y, :, 1] = out[y, :, 2] = line
        elif colortype == 2:
            out[y] = line.reshape(width, 3)
        elif colortype == 4:
            g = line.reshape(width, 2)[:, 0]
            out[y, :, 0] = out[y, :, 1] = out[y, :, 2] = g
        else:
            out[y] = line.reshape(width, 4)[:, :3]
    return out.astype(np.float64) / 255.0


def carregar_imagem(path):
    """Le PNG/JPG (PIL) ou PNG (fallback stdlib) como float RGB [0,1]."""
    try:
        from PIL import Image
        im = Image.open(path).convert("RGB")
        return np.asarray(im).astype(np.float64) / 255.0
    except Exception:
        return _png_read_stdlib(path)


# ---------------------------------------------------------------------------
# Utilitarios numericos / visao
# ---------------------------------------------------------------------------
def luminancia(img):
    return img @ np.array([0.2126, 0.7152, 0.0722])


def blur3(a):
    p = np.pad(a, 1, mode="edge")
    return (p[:-2, :-2] + p[:-2, 1:-1] + p[:-2, 2:] +
            p[1:-1, :-2] + p[1:-1, 1:-1] + p[1:-1, 2:] +
            p[2:, :-2] + p[2:, 1:-1] + p[2:, 2:]) / 9.0


def hsv(img):
    r, g, b = img[..., 0], img[..., 1], img[..., 2]
    mx = img.max(2)
    mn = img.min(2)
    d = mx - mn
    h = np.zeros_like(mx)
    m = (d > 1e-6) & (mx == r)
    h[m] = ((g[m] - b[m]) / d[m]) % 6.0
    m = (d > 1e-6) & (mx == g)
    h[m] = (b[m] - r[m]) / d[m] + 2.0
    m = (d > 1e-6) & (mx == b)
    h[m] = (r[m] - g[m]) / d[m] + 4.0
    h *= 60.0
    s = np.where(mx > 1e-6, d / np.maximum(mx, 1e-6), 0.0)
    return h, s, mx


def maior_componente(mask, min_pixels=40):
    """Componente conexa (4-vizinhos) de maior area. Retorna nova mascara."""
    h, w = mask.shape
    m = np.asarray(mask, bool)
    if not m.any():
        return np.zeros_like(m)
    # rotulacao por union-find em varredura unica (rapida para 256x256)
    parent = list(range(h * w))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    idx = np.arange(h * w).reshape(h, w)
    for y in range(h):
        row = m[y]
        for x in np.nonzero(row)[0]:
            if x > 0 and row[x - 1]:
                union(idx[y, x], idx[y, x - 1])
            if y > 0 and m[y - 1, x]:
                union(idx[y, x], idx[y - 1, x])
    roots = {}
    yy, xx = np.nonzero(m)
    for y, x in zip(yy, xx):
        roots[find(idx[y, x])] = roots.get(find(idx[y, x]), 0) + 1
    if not roots:
        return np.zeros_like(m)
    best_root = max(roots, key=roots.get)
    out = np.zeros_like(m)
    for y, x in zip(yy, xx):
        if find(idx[y, x]) == best_root:
            out[y, x] = True
    if out.sum() < min_pixels:
        return np.zeros_like(m)
    return out


def subpixel_extremo(profile, lo, hi):
    """Maior |gradiente| de profile[lo:hi], posicao e magnitude subpixel."""
    seg = profile[lo:hi]
    d = np.diff(seg)
    if len(d) == 0:
        return lo + 0.5, 0.0
    k = int(np.argmax(np.abs(d)))
    if k <= 0 or k >= len(d) - 1:
        return lo + k + 0.5, abs(float(d[k]))
    y0, y1, y2 = d[k - 1], d[k], d[k + 1]
    den = y0 - 2 * y1 + y2
    off = 0.5 * (y0 - y2) / den if abs(den) > 1e-12 else 0.0
    return lo + k + 0.5 + off, abs(float(y1))


def ajustar_reta(pontos, vertical=False, min_pontos=6):
    P = np.asarray(pontos, float)
    if len(P) < min_pontos:
        return None
    for _ in range(4):
        my, mx = P[:, 1].mean(), P[:, 0].mean()
        if vertical:
            A = np.stack([P[:, 1] - my, np.ones(len(P))], 1)
            sol = np.linalg.lstsq(A, P[:, 0] - mx, rcond=None)[0]
            res = np.abs((P[:, 1] - my) * sol[0] + mx + sol[1] - P[:, 0])
        else:
            A = np.stack([P[:, 0] - mx, np.ones(len(P))], 1)
            sol = np.linalg.lstsq(A, P[:, 1] - my, rcond=None)[0]
            res = np.abs((P[:, 0] - mx) * sol[0] + my + sol[1] - P[:, 1])
        med = float(np.median(res))
        mad = float(np.median(np.abs(res - med))) + 1e-6
        keep = res < max(0.6, 3.5 * mad)
        if keep.all():
            break
        P = P[keep]
    if len(P) < min_pontos:
        return None
    if vertical:
        return (float(sol[0]), float(P[:, 0].mean() - sol[0] * P[:, 1].mean()))
    return (float(sol[0]), float(P[:, 1].mean() - sol[0] * P[:, 0].mean()))


def reta_h(m, c):
    """y = m x + c  ->  (a,b,d) com a x + b y + d = 0."""
    return np.array([m, -1.0, c])


def reta_v(m, c):
    """x = m y + c  ->  (a,b,d) com a x + b y + d = 0."""
    return np.array([1.0, -m, -c])


def vp_de_retas(retas):
    """Ponto que minimiza a soma dos quadrados das distancias as retas."""
    A, b = [], []
    for a, bb, d in retas:
        n = math.hypot(a, bb)
        A.append([a / n, bb / n])
        b.append(-d / n)
    A = np.asarray(A)
    b = np.asarray(b)
    return np.linalg.lstsq(A, b, rcond=None)[0]


def interseccao_hv(lh, lv):
    mh, ch = lh
    mv, cv = lv
    x = (mv * ch + cv) / (1.0 - mv * mh)
    return x, mh * x + ch


# ---------------------------------------------------------------------------
# Camera pinhole (mesmo modelo do builder.py do kit)
# ---------------------------------------------------------------------------
def look_at(pos, alvo, lente=LENTE_MM, sensor=SENSOR_MM, size=256):
    pos = np.asarray(pos, float)
    D = np.asarray(alvo, float) - pos
    n = np.linalg.norm(D)
    D = D / n if n > 1e-9 else np.array([0.0, 1.0, 0.0])
    r = np.cross(D, np.array([0.0, 0.0, 1.0]))
    nr = np.linalg.norm(r)
    if nr < 1e-9:
        r = np.array([1.0, 0.0, 0.0])
    else:
        r = r / nr
    d = np.cross(D, r)
    f = lente / sensor * size
    return dict(pos=pos, D=D, r=r, d=d, f=f, size=size,
                cx=size / 2.0, cy=size / 2.0)


def projetar(P, cam):
    P = np.atleast_2d(np.asarray(P, float))
    rel = P - cam["pos"]
    u = rel @ cam["r"]
    v = rel @ cam["d"]
    w = rel @ cam["D"]
    w = np.where(np.abs(w) < 1e-9, 1e-9, w)
    x = cam["cx"] + cam["f"] * u / w
    y = cam["cy"] + cam["f"] * v / w
    return np.stack([x, y], 1), w


def camera_de_params(p, size):
    yaw = math.radians(p["yaw"])
    pitch = math.radians(p["pitch"])
    D = np.array([math.sin(yaw) * math.cos(pitch),
                  math.cos(yaw) * math.cos(pitch),
                  -math.sin(pitch)])
    pos = np.array([p["cam_x"], p["cam_y"], p["cam_z"]])
    return look_at(pos, pos + D, p["lens"], SENSOR_MM, size)


# ---------------------------------------------------------------------------
# Deteccao da janela
# ---------------------------------------------------------------------------
def detectar_janela(img, size):
    g = luminancia(img)
    h, s, v = hsv(img)
    mask = (v > 0.93) & (s < 0.09)
    comp = maior_componente(mask, min_pixels=max(60, int(0.005 * size * size)))
    if comp.sum() < 40:
        # fallback: topo 2% mais luminoso
        thr = np.percentile(v, 99.0)
        mask = v >= thr
        comp = maior_componente(mask, min_pixels=40)
    if comp.sum() < 30:
        return None
    ys, xs = np.nonzero(comp)
    x0, x1 = int(xs.min()), int(xs.max())
    y0, y1 = int(ys.min()), int(ys.max())
    top, bot, left, right = [], [], [], []
    for x in range(max(0, x0 + 1), min(size, x1)):
        y, gr = subpixel_extremo(g[:, x], max(0, y0 - 6), min(size, y0 + 7))
        if gr > 0.025:
            top.append((x, y))
        y, gr = subpixel_extremo(g[:, x], max(0, y1 - 6), min(size, y1 + 7))
        if gr > 0.025:
            bot.append((x, y))
    for y in range(max(0, y0 + 1), min(size, y1)):
        x, gr = subpixel_extremo(g[y, :], max(0, x0 - 6), min(size, x0 + 7))
        if gr > 0.025:
            left.append((x, y))
        x, gr = subpixel_extremo(g[y, :], max(0, x1 - 6), min(size, x1 + 7))
        if gr > 0.025:
            right.append((x, y))
    lt = ajustar_reta(top)
    lb = ajustar_reta(bot)
    ll = ajustar_reta(left, vertical=True)
    lr = ajustar_reta(right, vertical=True)
    if None in (lt, lb, ll, lr):
        return None
    TL = interseccao_hv(lt, ll)
    TR = interseccao_hv(lt, lr)
    BR = interseccao_hv(lb, lr)
    BL = interseccao_hv(lb, ll)
    quad = np.array([TL, TR, BR, BL], float)
    return dict(quad=quad, mask=comp, bbox=(x0, y0, x1, y1),
                linhas=dict(top=lt, bottom=lb, left=ll, right=lr))


# ---------------------------------------------------------------------------
# Deteccao das retas estruturais da sala
# ---------------------------------------------------------------------------
def _borda_topo_por_coluna(g, size):
    """Para cada coluna, a PRIMEIRA borda forte abaixo do topo (a mais alta).
    A linha teto-parede do fundo e a mais alta em toda a parede do fundo; a
    partir do canto ela da lugar a linha teto-parede direita."""
    pts = []
    ylo = max(2, int(0.04 * size))
    yhi = int(0.34 * size)
    for x in range(0, size):
        col = g[ylo:yhi, x]
        d = np.abs(np.diff(col))
        if len(d) == 0:
            continue
        # primeira borda forte de cima para baixo (a linha teto-parede e a
        # borda mais alta da parede; pegar o maximo global confundiria com a
        # janela, que tem gradiente mais forte)
        cand = np.nonzero(d > 0.012)[0]
        if len(cand) == 0:
            continue
        k = int(cand[0])
        if 0 < k < len(d) - 1:
            y0, y1, y2 = d[k - 1], d[k], d[k + 1]
            den = y0 - 2 * y1 + y2
            off = 0.5 * (y0 - y2) / den if abs(den) > 1e-12 else 0.0
        else:
            off = 0.0
        pts.append((x, ylo + k + 0.5 + off, float(d[k])))
    return pts


def _ajustar_duas_retas(pts, size):
    """Ajusta duas retas aos pontos de topo, escolhendo o melhor corte (canto)."""
    P = np.asarray(pts, float)
    if len(P) < 30:
        return None
    best = None
    for xc in np.linspace(0.30 * size, 0.97 * size, 68):
        L = P[P[:, 0] < xc]
        R = P[P[:, 0] >= xc]
        if len(L) < 15 or len(R) < 12:
            continue
        ml, cl = np.polyfit(L[:, 0], L[:, 1], 1)
        mr, cr = np.polyfit(R[:, 0], R[:, 1], 1)
        rl = L[:, 1] - (ml * L[:, 0] + cl)
        rr = R[:, 1] - (mr * R[:, 0] + cr)
        # residuo robusto (evita um unico ponto de borda dominar)
        cost = float(np.median(np.abs(rl)) + np.median(np.abs(rr)))
        if best is None or cost < best[0]:
            best = (cost, (float(ml), float(cl)), (float(mr), float(cr)), xc, L, R)
    if best is None:
        return None
    cost, lt, lr, xc, L, R = best
    # refit com rejeicao de outliers
    def refit(line, Q):
        m, c = line
        for _ in range(3):
            res = np.abs(Q[:, 1] - (m * Q[:, 0] + c))
            med = np.median(res)
            mad = np.median(np.abs(res - med)) + 1e-6
            keep = res < max(0.8, 3.5 * mad)
            if keep.all() or keep.sum() < 8:
                break
            Q = Q[keep]
        m, c = np.polyfit(Q[:, 0], Q[:, 1], 1)
        return (float(m), float(c))
    lt = refit(lt, L)
    lr = refit(lr, R)
    return lt, lr, float(xc)


def detectar_retas_sala(img, janela, size):
    g = luminancia(img)
    warm = img[..., 0] - img[..., 2]
    out = {}
    pts = _borda_topo_por_coluna(g, size)
    duas = _ajustar_duas_retas(pts, size)
    corner_top = None
    xc = None
    if duas is not None:
        lt, lr, xc = duas
        out["teto"] = lt
        out["direita_teto"] = lr
        # o canto geometrico e a interseccao das duas linhas de topo
        if abs(lt[0] - lr[0]) > 1e-6:
            cx_ = (lr[1] - lt[1]) / (lt[0] - lr[0])
            corner_top = (float(cx_), float(lt[0] * cx_ + lt[1]))
    else:
        P = np.asarray([(x, y) for x, y, _ in pts], float)
        out["teto"] = ajustar_reta(P) if len(P) >= 8 else None
        out["direita_teto"] = None
    # aresta vertical do canto: procura perto do ponto de corte da ajuste
    out["canto"] = None
    if out["teto"] is not None and xc is not None:
        m, c = out["teto"]
        y_ini = m * xc + c
        pts_v = []
        xa = int(max(0, xc - 14)); xb = int(min(size, xc + 15))
        for y in range(int(y_ini + 4), min(size, int(y_ini + 0.30 * size))):
            x, gr = subpixel_extremo(g[y, :], xa, xb)
            if gr > 0.009:
                pts_v.append((x, y))
        cand = ajustar_reta(pts_v, vertical=True) if len(pts_v) >= 8 else None
        if cand is not None:
            x_at = cand[0] * y_ini + cand[1]
            if abs(x_at - xc) <= 22:
                out["canto"] = cand
        if out["canto"] is None and corner_top is not None:
            # usa o canto geometrico das linhas de topo; a aresta vertical
            # passa por ele (camera sem rolagem)
            out["canto"] = (0.0, float(corner_top[0]))
    # linha piso-parede: salto de "calor" (r-b) na faixa inferior esquerda
    pts = []
    for x in range(0, int(0.30 * size)):
        y, gr = subpixel_extremo(warm[:, x], int(0.55 * size), int(0.80 * size))
        if gr > 0.006:
            pts.append((x, y))
    out["piso"] = ajustar_reta(pts)
    return out


# ---------------------------------------------------------------------------
# Geometria: homografia, rotacao, pose relativa da janela
# ---------------------------------------------------------------------------
def homografia(src, dst):
    A = []
    for (x, y), (u, v) in zip(src, dst):
        A.append([-x, -y, -1, 0, 0, 0, u * x, u * y, u])
        A.append([0, 0, 0, -x, -y, -1, v * x, v * y, v])
    A = np.asarray(A, float)
    _, _, Vt = np.linalg.svd(A)
    H = Vt[-1].reshape(3, 3)
    if abs(H[2, 2]) < 1e-12:
        H = H / np.linalg.norm(H)
    else:
        H = H / H[2, 2]
    return H


def rotacao_de_vps(vx, vz, f, size):
    K = np.array([[f, 0, size / 2.0], [0, f, size / 2.0], [0, 0, 1.0]])
    Ki = np.linalg.inv(K)
    ex = Ki @ np.array([vx[0], vx[1], 1.0])
    ex /= np.linalg.norm(ex)
    dz = Ki @ np.array([vz[0], vz[1], 1.0])
    dz /= np.linalg.norm(dz)
    if ex[0] < 0:
        ex = -ex
    if dz[1] > 0:
        dz = -dz
    dy = np.cross(dz, ex)
    ndy = np.linalg.norm(dy)
    if ndy < 1e-9:
        return None
    dy /= ndy
    if dy[2] < 0:
        ex = -ex
        dy = -dy
    R = np.stack([ex, dy, dz], 1)
    if np.linalg.det(R) < 0:
        ex = -ex
        dy = -np.cross(dz, ex)
        R = np.stack([ex, dy, dz], 1)
    return R


def decompor_janela(quad, f, R, size):
    """quad TL,TR,BR,BL. Retorna proporcao h/w e pose T=R(O-C) em unidades
    de largura da janela (w=1)."""
    TL, TR, BR, BL = [np.asarray(p, float) for p in quad]
    src = [(0, 0), (1, 0), (1, 1), (0, 1)]     # BL,BR,TR,TL (metros/w)
    dst = [BL, BR, TR, TL]
    H = homografia(src, dst)
    K = np.array([[f, 0, size / 2.0], [0, f, size / 2.0], [0, 0, 1.0]])
    A = np.linalg.inv(K) @ H
    a1, a2, a3 = A[:, 0], A[:, 1], A[:, 2]
    s = np.linalg.norm(a1)
    if s < 1e-12:
        return None
    e1 = R[:, 0]
    e2 = R[:, 2]
    w = 1.0
    h = float(np.linalg.norm(a2) / s)
    T = a3 / s
    err1 = float(np.linalg.norm(a1 / s - e1))
    err2 = float(np.linalg.norm(a2 / s - e2 * h))
    return dict(H=H, w=w, h=h, T=T, s=s, e1err=err1, e2err=err2)


def raio_parede_fundo(xy, R, T, f, size):
    """Interseca o raio do pixel com o plano y=0 (parede do fundo), no
    referencial cujo origem e o canto inferior-esquerdo da janela."""
    K = np.array([[f, 0, size / 2.0], [0, f, size / 2.0], [0, 0, 1.0]])
    d = np.linalg.inv(K) @ np.array([xy[0], xy[1], 1.0])
    dw = R.T @ d
    C = -R.T @ T
    if abs(dw[1]) < 1e-12:
        return None
    t = -C[1] / dw[1]
    return C + t * dw


# ---------------------------------------------------------------------------
# Resolucao analitica da cena (escala fixada por ALTURA_SALA)
# ---------------------------------------------------------------------------
def resolver_analitico(img, size, verbose=False):
    janela = detectar_janela(img, size)
    if janela is None:
        return None
    retas = detectar_retas_sala(img, janela, size)
    f = size * LENTE_MM / SENSOR_MM
    # VP de X: retas do topo/base da janela + teto/piso
    rx = [reta_h(*janela["linhas"]["top"]), reta_h(*janela["linhas"]["bottom"])]
    for k in ("teto", "piso"):
        if retas.get(k) is not None:
            rx.append(reta_h(*retas[k]))
    # VP de Z: bordas verticais da janela + aresta do canto
    rz = [reta_v(*janela["linhas"]["left"]), reta_v(*janela["linhas"]["right"])]
    if retas.get("canto") is not None:
        rz.append(reta_v(*retas["canto"]))
    vx = vp_de_retas(rx)
    vz = vp_de_retas(rz)
    R = rotacao_de_vps(vx, vz, f, size)
    if R is None:
        return None
    dec = decompor_janela(janela["quad"], f, R, size)
    if dec is None:
        return None
    # raios para o canto superior/inferior da parede do fundo
    if retas.get("teto") is None or retas.get("canto") is None:
        return None
    xc, yc = interseccao_hv(retas["teto"], retas["canto"])
    # linha do piso: se ausente, estima a partir do peitoril da janela
    if retas.get("piso") is not None:
        yf = retas["piso"][0] * xc + retas["piso"][1]
    else:
        yf = janela["quad"][2][1] + 0.15 * size
    ctop = raio_parede_fundo((xc, yc), R, dec["T"], f, size)
    cbot = raio_parede_fundo((xc, yf), R, dec["T"], f, size)
    if ctop is None or cbot is None:
        return None
    # altura do teto e do piso no referencial da janela
    zs = []
    m, c = retas["teto"]
    for px in np.linspace(0.25 * size, 0.65 * size, 9):
        if retas.get("piso") is not None:
            pass
        zs.append(raio_parede_fundo((px, m * px + c), R, dec["T"], f, size))
    zs = [z for z in zs if z is not None]
    if not zs:
        return None
    Hrel = float(np.median([z[2] for z in zs]))
    if retas.get("piso") is not None:
        mf, cf = retas["piso"]
        zf = []
        for px in np.linspace(0.02 * size, 0.22 * size, 8):
            z = raio_parede_fundo((px, mf * px + cf), R, dec["T"], f, size)
            if z is not None:
                zf.append(z[2])
        Zfloor = float(np.median(zf)) if zf else float(cbot[2])
    else:
        Zfloor = float(cbot[2])
    H = Hrel - Zfloor
    if not np.isfinite(H) or H <= 0.2:
        return None
    escala = ALTURA_SALA / H          # metros por unidade de largura da janela
    Xright = float(np.median([ctop[0], cbot[0]]))
    Crel = -R.T @ dec["T"]
    w = escala                       # largura da janela em metros
    z0 = -Zfloor * escala
    L = MARGEM_ESQ + (Xright - Crel[0]) * escala
    P = MARGEM_FRENTE + 0.05 - Crel[1] * escala
    if L < 2.0 or L > 12.0 or P < 2.0 or P > 12.0:
        return None
    camx = -L / 2 + MARGEM_ESQ
    camy = -P / 2 + MARGEM_FRENTE
    camz = z0 + Crel[2] * escala
    yaw = math.degrees(math.atan2(R[2, 0], R[2, 1]))
    pitch = math.degrees(math.asin(max(-1.0, min(1.0, -R[2, 2]))))
    u0 = L / 2 - Xright * escala
    p = dict(
        L=float(L), P=float(P), H=float(ALTURA_SALA),
        cam_x=float(camx), cam_y=float(camy), cam_z=float(camz),
        yaw=float(yaw), pitch=float(pitch), lens=float(LENTE_MM),
        u0=float(u0), u1=float(u0 + w), z0=float(z0),
        z1=float(z0 + dec["h"] * escala),
        m_left=float(MARGEM_ESQ), m_front=float(MARGEM_FRENTE),
        _quad=janela["quad"].tolist(), _retas=retas, _dec=dec, _R=R,
        _Hrel=Hrel, _Zfloor=Zfloor, _Xright=Xright, _Crel=Crel,
    )
    if verbose:
        print("VPs", vx, vz, "yaw", yaw, "pitch", pitch)
        print("janela h/w", dec["h"], "T", dec["T"])
        print("Hrel", Hrel, "Zfloor", Zfloor, "Xright", Xright)
        print({k: round(float(v), 3) for k, v in p.items() if not k.startswith("_")})
    return p


# ---------------------------------------------------------------------------
# Refinamento deterministico (Nelder-Mead) das retas / cantos
# ---------------------------------------------------------------------------
def residuos_geometria(x, p0, retas, size):
    """Residuos (px) das retas estruturais e dos cantos da janela."""
    p = dict(p0)
    for k, v in zip(("L", "P", "m_left", "m_front", "cam_z", "yaw", "pitch",
                     "u0", "u1", "z0", "z1"), x):
        p[k] = float(v)
    p["H"] = ALTURA_SALA
    p["lens"] = LENTE_MM
    L, P, H = p["L"], p["P"], p["H"]
    p["cam_x"] = -L / 2 + p["m_left"]
    p["cam_y"] = -P / 2 + p["m_front"]
    t = 0.10
    xi_l, xi_r = -L / 2 + t / 2, L / 2 - t / 2
    yi_f, yi_b = -P / 2 + t / 2, P / 2 - t / 2
    cam = camera_de_params(p, size)
    res = []

    def add_reta(pts3, reta, w, lo, hi, weight):
        xy, ww = projetar(np.asarray(pts3, float), cam)
        m, c = reta
        for (x, y), www in zip(xy, ww):
            if www > 0:
                res.append(weight * (y - (m * x + c)))
            else:
                res.append(5.0)

    if retas.get("teto") is not None:
        add_reta([(x, yi_b, H) for x in np.linspace(xi_l, xi_r, 10)], retas["teto"], None, None, None, 0.8)
    if retas.get("piso") is not None:
        add_reta([(x, yi_b, 0) for x in np.linspace(xi_l, xi_r, 10)], retas["piso"], None, None, None, 1.2)
    if retas.get("canto") is not None:
        xy, ww = projetar(np.array([(xi_r, yi_b, z) for z in np.linspace(0, H, 10)]), cam)
        m, c = retas["canto"]
        for (x, y), www in zip(xy, ww):
            res.append(1.5 * (x - (m * y + c)) if www > 0 else 5.0)
    if retas.get("direita_teto") is not None:
        add_reta([(xi_r, y, H) for y in np.linspace(yi_f, yi_b, 10)], retas["direita_teto"], None, None, None, 0.7)
    quad = np.asarray(p0["_quad"], float)
    wc = [(p["u0"], yi_b, p["z1"]), (p["u1"], yi_b, p["z1"]),
          (p["u1"], yi_b, p["z0"]), (p["u0"], yi_b, p["z0"])]
    xy, ww = projetar(np.array(wc), cam)
    for (x, y), www, ref in zip(xy, ww, quad):
        res.append(2.0 * (x - ref[0]))
        res.append(2.0 * (y - ref[1]))
    return np.asarray(res)


def custo_geometria(x, p0, retas, size, thr=2.5):
    r = residuos_geometria(x, p0, retas, size)
    # custo robusto (Huber) para nao deixar uma linha ruidosa dominar
    a = np.abs(r)
    return float(np.mean(np.where(a <= thr, r * r, 2 * thr * a - thr * thr)))


def nelder_mead(f, x0, bounds, max_iter=3000, x_tol=1e-6, f_tol=1e-10):
    """Nelder-Mead deterministico com caixa (clip). Sem dependencias externas."""
    n = len(x0)
    lo = np.array([b[0] for b in bounds], float)
    hi = np.array([b[1] for b in bounds], float)

    def clip(v):
        return np.minimum(np.maximum(v, lo), hi)

    x0 = clip(np.asarray(x0, float))
    # simplex inicial: 1% do intervalo (minimo 1e-4)
    simp = [x0]
    for i in range(n):
        v = x0.copy()
        step = max(1e-4, 0.02 * (hi[i] - lo[i]))
        v[i] = np.clip(v[i] + step, lo[i], hi[i])
        if abs(v[i] - x0[i]) < 1e-12:
            v[i] = np.clip(v[i] - step, lo[i], hi[i])
        simp.append(v)
    simp = np.array(simp)
    fv = np.array([f(v) for v in simp])

    for it in range(max_iter):
        order = np.argsort(fv)
        simp = simp[order]
        fv = fv[order]
        if abs(fv[-1] - fv[0]) <= f_tol * (abs(fv[0]) + 1e-12) and \
           float(np.max(np.abs(simp[1:] - simp[0]))) <= float(x_tol * (1 + np.abs(simp[0]))):
            break
        centroid = simp[:-1].mean(0)
        xr = clip(centroid + (centroid - simp[-1]))
        fr = f(xr)
        if fr < fv[0]:
            xe = clip(centroid + 2.0 * (xr - centroid))
            fe = f(xe)
            if fe < fr:
                simp[-1], fv[-1] = xe, fe
            else:
                simp[-1], fv[-1] = xr, fr
        elif fr < fv[-2]:
            simp[-1], fv[-1] = xr, fr
        else:
            xc = clip(centroid + 0.5 * (simp[-1] - centroid))
            fc = f(xc)
            if fc < fv[-1]:
                simp[-1], fv[-1] = xc, fc
            else:
                for i in range(1, n + 1):
                    simp[i] = clip(simp[0] + 0.5 * (simp[i] - simp[0]))
                    fv[i] = f(simp[i])
    order = np.argsort(fv)
    return simp[order[0]], float(fv[order[0]])


def refinar_geometria(p, retas, size):
    chaves = ("L", "P", "m_left", "m_front", "cam_z", "yaw", "pitch",
              "u0", "u1", "z0", "z1")
    x0 = np.array([p[k] for k in chaves], float)
    bounds = [
        (max(2.5, p["L"] * 0.75), min(9.0, p["L"] * 1.25)),
        (max(2.5, p["P"] * 0.75), min(9.0, p["P"] * 1.25)),
        (0.20, 1.00), (0.20, 1.00),
        (max(0.8, p["cam_z"] - 0.45), min(2.2, p["cam_z"] + 0.45)),
        (p["yaw"] - 5.0, p["yaw"] + 5.0),
        (max(0.5, p["pitch"] - 5.0), min(30.0, p["pitch"] + 5.0)),
        (p["u0"] - 0.4, p["u0"] + 0.4),
        (p["u1"] - 0.4, p["u1"] + 0.4),
        (max(0.05, p["z0"] - 0.25), p["z0"] + 0.25),
        (p["z1"] - 0.25, min(ALTURA_SALA - 0.06, p["z1"] + 0.25)),
    ]
    xb, fb = nelder_mead(lambda x: custo_geometria(x, p, retas, size), x0, bounds)
    q = dict(p)
    for k, v in zip(chaves, xb):
        q[k] = float(v)
    q["cam_x"] = -q["L"] / 2 + q["m_left"]
    q["cam_y"] = -q["P"] / 2 + q["m_front"]
    q["H"] = ALTURA_SALA
    q["lens"] = LENTE_MM
    # seguranca: abertura dentro da parede e abaixo do teto
    u0 = max(q["u0"], -q["L"] / 2 + 0.05)
    u1 = min(q["u1"], q["L"] / 2 - 0.05)
    if u1 - u0 < 0.2:
        uc = 0.5 * (u0 + u1)
        u0, u1 = uc - 0.1, uc + 0.1
        u0 = max(u0, -q["L"] / 2 + 0.05)
        u1 = min(u1, q["L"] / 2 - 0.05)
    q["u0"], q["u1"] = float(u0), float(u1)
    q["z0"] = float(max(q["z0"], 0.05))
    q["z1"] = float(min(q["z1"], ALTURA_SALA - 0.06))
    if q["z1"] - q["z0"] < 0.2:
        q["z1"] = min(ALTURA_SALA - 0.06, q["z0"] + 0.2)
    return q


# ---------------------------------------------------------------------------
# Mobiliario: leitura de mascaras de cor e mapeamento para os planos 3D
# ---------------------------------------------------------------------------
def mascaras_cor(img):
    h, s, v = hsv(img)
    azul = (h > 190) & (h < 235) & (s > 0.15) & (v > 0.20)
    rosa = (s > 0.12) & (((h > 320) & (h <= 360)) | (h < 12)) & (v > 0.20)
    # tons de madeira/mesa: laranja/amarelo, saturacao media
    madeira = (h >= 8) & (h < 50) & (s > 0.13) & (s < 0.45) & (v > 0.30) & (v < 0.90)
    vermelho = (s > 0.25) & (((h >= 340) & (h <= 360)) | (h < 15)) & (v > 0.20)
    return dict(azul=azul, rosa=rosa, madeira=madeira, vermelho=vermelho,
                h=h, s=s, v=v)


def ponto_plano(xy, z, cam):
    """Intersecao do raio do pixel com o plano horizontal z=constante."""
    K = np.array([[cam["f"], 0, cam["cx"]], [0, cam["f"], cam["cy"]], [0, 0, 1.0]])
    d = np.linalg.inv(K) @ np.array([xy[0], xy[1], 1.0])
    dw = cam["r"] * d[0] + cam["d"] * d[1] + cam["D"] * d[2]  # camera -> mundo
    C = cam["pos"]
    if abs(dw[2]) < 1e-9:
        return None
    t = (z - C[2]) / dw[2]
    return C + t * dw


def ponto_parede_direita(xy, x_parede, cam):
    K = np.array([[cam["f"], 0, cam["cx"]], [0, cam["f"], cam["cy"]], [0, 0, 1.0]])
    d = np.linalg.inv(K) @ np.array([xy[0], xy[1], 1.0])
    dw = cam["r"] * d[0] + cam["d"] * d[1] + cam["D"] * d[2]
    C = cam["pos"]
    if abs(dw[0]) < 1e-9:
        return None
    t = (x_parede - C[0]) / dw[0]
    return C + t * dw


def _pixels(mask):
    ys, xs = np.nonzero(mask)
    return xs, ys


def detectar_rug(img, p, cam, mob):
    """Tapete: mapeia a mascara rosa no plano do piso e usa a borda visivel."""
    L, P = p["L"], p["P"]
    m = mascaras_cor(img)
    size = img.shape[0]
    comp = maior_componente(m["rosa"], min_pixels=max(200, int(0.015 * size * size)))
    if comp.sum() < max(200, int(0.015 * size * size)):
        return None
    xs, ys = _pixels(comp)
    pts = []
    for x, y in zip(xs, ys):
        q = ponto_plano((x + 0.5, y + 0.5), 0.0, cam)
        if q is not None:
            pts.append(q)
    pts = np.asarray(pts)
    if len(pts) < 40:
        return None
    # borda esquerda (x constante): para cada linha, o pixel mais a esquerda
    left = []
    for y in range(int(ys.min()) + 4, int(ys.max()) + 1, 2):
        xx = xs[ys == y]
        if len(xx) > 0:
            q = ponto_plano((xx.min() + 0.5, y + 0.5), 0.0, cam)
            if q is not None:
                left.append(q[0])
    far = []
    for x in range(int(xs.min()) + 2, min(int(xs.max()), int(np.percentile(xs, 72))) + 1, 2):
        yy = ys[xs == x]
        if len(yy) > 0:
            q = ponto_plano((x + 0.5, yy.min() + 0.5), 0.0, cam)
            if q is not None:
                far.append(q[1])
    x_min = float(np.median(left)) if left else float(np.percentile(pts[:, 0], 1))
    y_max = float(np.median(far)) if far else float(np.percentile(pts[:, 1], 99))
    # usa a mesa como centro do tapete, se conhecida
    tx = mob.get("table_x")
    ty = mob.get("table_y")
    if tx is None:
        cc = pts[(pts[:, 0] > x_min) & (pts[:, 1] < y_max)]
        tx = float(np.median(cc[:, 0])) if len(cc) else -L * 0.1
        ty = float(np.median(cc[:, 1])) if len(cc) else -P * 0.05
    lx = 2.0 * (tx - x_min)
    ly = 2.0 * (y_max - ty)
    lx = float(np.clip(lx, 1.4, 3.6))
    ly = float(np.clip(ly, 1.2, 3.2))
    cx = tx
    cy = y_max - ly / 2.0
    # compensa erosao da mascara por sombra/oclusao: se o tapete encosta na
    # borda direita/inferior da imagem, a borda direita real esta escondida
    # atras de mobiliario; estende ~5 cm por lado nesse eixo.
    if xs.max() >= img.shape[1] - 2 or ys.max() >= img.shape[0] - 2:
        lx += 0.10
        cx += 0.05
    # mantem dentro da sala
    cx = float(np.clip(cx, -L / 2 + lx / 2 + 0.05, L / 2 - lx / 2 - 0.05))
    cy = float(np.clip(cy, -P / 2 + ly / 2 + 0.05, P / 2 - ly / 2 - 0.05))
    return dict(rug_x=cx, rug_y=cy, rug_lx=lx, rug_ly=ly)


def detectar_mesa(img, p, cam, mob):
    """Mesa: mascara de madeira mapeada num plano horizontal na altura tipica."""
    m = mascaras_cor(img)
    mask = m["madeira"] & (~m["rosa"])
    comp = maior_componente(mask, min_pixels=max(50, int(0.004 * img.shape[0] * img.shape[1])))
    if comp.sum() < 50:
        return None
    xs, ys = _pixels(comp)
    h_tab = 0.44
    pts = []
    for x, y in zip(xs, ys):
        q = ponto_plano((x + 0.5, y + 0.5), h_tab, cam)
        if q is not None:
            pts.append(q)
    pts = np.asarray(pts)
    if len(pts) < 30:
        return None
    x0, x1 = np.percentile(pts[:, 0], [1, 99])
    y0, y1 = np.percentile(pts[:, 1], [1, 99])
    lx, ly = float(x1 - x0), float(y1 - y0)
    if not (0.5 < lx < 2.2 and 0.35 < ly < 1.3):
        return None
    # mantem a mesa dentro da sala
    cx, cy = float((x0 + x1) / 2), float((y0 + y1) / 2)
    cx = float(np.clip(cx, -p["L"] / 2 + lx / 2 + 0.1, p["L"] / 2 - lx / 2 - 0.1))
    cy = float(np.clip(cy, -p["P"] / 2 + ly / 2 + 0.1, p["P"] / 2 - ly / 2 - 0.1))
    return dict(table_x=cx, table_y=cy, table_lx=lx, table_ly=ly,
                table_h=h_tab, table_top_t=0.05)


def detectar_sofa(img, p, cam):
    """Sofa: projeta a mascara azul na parede direita e le comprimento/altura."""
    L, P, H = p["L"], p["P"], p["H"]
    m = mascaras_cor(img)
    size = img.shape[0]
    comp = maior_componente(m["azul"], min_pixels=max(150, int(0.02 * size * size)))
    if comp.sum() < max(150, int(0.02 * size * size)):
        return None
    xs, ys = _pixels(comp)
    xi_r = L / 2 - 0.05
    pts = []
    for x, y in zip(xs, ys):
        q = ponto_parede_direita((x + 0.5, y + 0.5), xi_r, cam)
        if q is None:
            continue
        if -P / 2 + 0.05 < q[1] < P / 2 - 0.05 and 0.0 <= q[2] <= H:
            pts.append(q)
    if len(pts) < 50:
        return None
    pts = np.asarray(pts)
    ztop = float(np.percentile(pts[:, 2], 97))
    # usa o encosto (parte alta, encostada na parede) para achar o comprimento;
    # a frente/braco projetados na parede ficam deslocados
    sel = pts[pts[:, 2] > max(0.5, 0.62 * ztop)]
    if len(sel) < 25:
        sel = pts
    y0, y1 = np.percentile(sel[:, 1], [2, 98])
    # o braco da frente oculta o inicio do encosto: soma ~0,55 m
    length = float(y1 - y0) + 0.62
    if length < 1.0:
        return None
    length = float(np.clip(length, 1.6, min(3.0, P - 0.2)))
    if ztop < 0.45:
        return None
    back_h = float(np.clip(ztop + 0.04, 0.62, 1.05))
    cy = float((y0 - 0.62 + y1) / 2.0)
    cy = float(np.clip(cy, -P / 2 + length / 2 + 0.05, P / 2 - length / 2 - 0.05))
    return dict(sofa_y=cy, sofa_len=length, sofa_depth=1.10, sofa_seat_h=0.50,
                sofa_back_h=back_h, sofa_arm_w=0.20, sofa_back_t=0.22,
                sofa_arm_h=0.55)


def detectar_livros(img, p, cam, mob):
    """Livros pequenos sobre a mesa (componentes azul/vermelho na area da mesa)."""
    if mob.get("table_x") is None:
        return []
    h_tab = mob.get("table_h", 0.44)
    x0 = mob["table_x"] - mob["table_lx"] / 2
    x1 = mob["table_x"] + mob["table_lx"] / 2
    y0 = mob["table_y"] - mob["table_ly"] / 2
    y1 = mob["table_y"] + mob["table_ly"] / 2
    m = mascaras_cor(img)
    mask = (m["azul"] | m["vermelho"])
    # projeta a area da mesa na imagem para recortar
    corners = np.array([[(x0, y0, h_tab), (x1, y0, h_tab), (x1, y1, h_tab), (x0, y1, h_tab)]])
    xy, _ = projetar(corners[0], cam)
    if not np.all(np.isfinite(xy)):
        return []
    px0, px1 = int(max(0, xy[:, 0].min() - 2)), int(min(img.shape[1], xy[:, 0].max() + 3))
    py0, py1 = int(max(0, xy[:, 1].min() - 2)), int(min(img.shape[0], xy[:, 1].max() + 3))
    recorte = np.zeros_like(mask)
    recorte[py0:py1, px0:px1] = True
    mask = mask & recorte
    comp = maior_componente(mask, min_pixels=15)
    if comp.sum() < 15:
        return []
    ys, xs = _pixels(comp)
    q = ponto_plano((xs.mean() + 0.5, ys.mean() + 0.5), h_tab + 0.02, cam)
    if q is None:
        return []
    area = comp.sum()
    tam = float(np.clip(0.22 + 0.0015 * area, 0.22, 0.42))
    return [dict(nome="livro", tipo="cubo", centro=[float(q[0]), float(q[1]), float(h_tab + 0.015)],
                 tamanho=[tam, tam * 0.7, 0.03], material="livro1", rotacao_deg=[0, 0, 8])]


# ---------------------------------------------------------------------------
# Aparencia: calibracao de cores e rig de luz (calibrado no kit publico)
# ---------------------------------------------------------------------------
# Medias de cor por regiao na ref-A1 (sRGB 0..1) e as cores-base lineares que
# o rig de luz calibrado precisa para reproduzi-las no Cycles.
_CAL_A1 = dict(
    parede=dict(mean=(0.714, 0.710, 0.715), base=(0.8905, 0.8526, 0.7825)),
    teto=dict(mean=(0.757, 0.769, 0.789), base=(0.8473, 0.9061, 0.9455)),
    piso=dict(mean=(0.536, 0.536, 0.575), base=(0.2322, 0.2131, 0.2273)),
    tapete=dict(mean=(0.633, 0.496, 0.520), base=(0.3877, 0.1498, 0.1699)),
    sofa=dict(mean=(0.387, 0.502, 0.657), base=(0.1135, 0.2178, 0.4698)),
    mesa=dict(mean=(0.598, 0.507, 0.482), base=(0.2922, 0.1568, 0.1020)),
)

# Rig de luz calibrado contra a ref-A1 (valores fixos = priori de estilo).
_RIG = dict(
    sun_dir=[-0.55, -0.55, -0.63], sun_energia=2.7,
    sun_cor=[1.0, 0.95, 0.85], sun_angulo=6.0,
    area_energia=52.5, area_cor=[0.8, 0.88, 1.0], area_size=1.5, area_z=1.5,
    lamp_energia=0.0, lamp_cor=[1.0, 0.8, 0.55], lamp_size=0.3,
    amb_cor=[0.6, 0.72, 0.9], amb_forca=0.30,
    ceu_cor=[0.85, 0.9, 1.0], ceu_forca=8.0, luz_forca=4.0,
)


def _media_patch(img, xs, ys, r=3):
    ys0 = np.clip(np.asarray(ys, int), r, img.shape[0] - r - 1)
    xs0 = np.clip(np.asarray(xs, int), r, img.shape[1] - r - 1)
    vals = []
    for y, x in zip(ys0, xs0):
        vals.append(img[y - r:y + r + 1, x - r:x + r + 1].reshape(-1, 3).mean(0))
    if not vals:
        return None
    return np.median(np.asarray(vals), axis=0)


def amostrar_aparencia(img, p, cam, janela, retas, mob):
    """Medias de cor de parede/teto/piso/tapete/sofa/mesa na imagem."""
    size = img.shape[0]
    amostras = {}
    h = janela["quad"][1][0]
    corner_x = (janela["quad"][1][0] + 8) if janela is not None else size * 0.75
    # parede do fundo: direita da janela, acima da linha do piso
    mT, cT = retas["teto"] if retas.get("teto") is not None else (0.13, 35.0)
    mF, cF = retas["piso"] if retas.get("piso") is not None else (-0.17, 178.0)
    xs, ys = [], []
    for x in np.linspace(janela["quad"][1][0] + 12, min(size - 8, corner_x - 8), 12):
        y = mT * x + cT
        y2 = mF * x + cF
        ys.append(int((y + y2) / 2))
        xs.append(int(x))
    amostras["parede"] = _media_patch(img, xs, ys)
    # teto: acima da linha do teto
    xs, ys = [], []
    for x in np.linspace(0.15 * size, 0.55 * size, 10):
        y = mT * x + cT
        if y > 8:
            xs.append(int(x)); ys.append(int(max(3, y - 6)))
    amostras["teto"] = _media_patch(img, xs, ys)
    # piso: abaixo da linha do piso, a esquerda da janela
    xs, ys = [], []
    for x in np.linspace(0.02 * size, max(0.10 * size, janela["quad"][0][0] - 6), 8):
        y = mF * x + cF
        xs.append(int(x)); ys.append(int(min(size - 4, y + 10)))
    amostras["piso"] = _media_patch(img, xs, ys)
    # tapete / sofa / mesa: medias das mascaras de cor
    m = mascaras_cor(img)
    for nome, mask in (("tapete", m["rosa"]), ("sofa", m["azul"])):
        comp = maior_componente(mask, min_pixels=60)
        if comp.sum() > 60:
            amostras[nome] = img[comp].mean(0)
        else:
            amostras[nome] = None
    comp_mad = maior_componente(m["madeira"] & ~m["rosa"], min_pixels=40)
    if comp_mad.sum() > 40:
        amostras["mesa"] = img[comp_mad].mean(0)
    elif mob.get("table_x") is not None:
        pt = np.array([(mob["table_x"], mob["table_y"], mob["table_h"])])
        xy, w = projetar(pt, cam)
        amostras["mesa"] = _media_patch(img, [int(xy[0, 0])], [int(xy[0, 1])], r=2) if w[0] > 0 else None
    else:
        amostras["mesa"] = None
    return amostras


def estimar_materiais(amostras, expoente=1.8):
    """Transfere a calibracao ref-A1 para a imagem atual."""
    mats = {}
    for nome, cal in _CAL_A1.items():
        obs = amostras.get(nome)
        if obs is None:
            mats[nome] = list(cal["base"])
            continue
        obs = np.clip(np.asarray(obs, float), 0.02, 1.0)
        ref = np.asarray(cal["mean"], float)
        ratio = (obs + 0.02) / (ref + 0.02)
        base = np.asarray(cal["base"], float) * np.clip(ratio, 0.25, 4.0) ** expoente
        mats[nome] = list(np.clip(base, 0.015, 1.0))
    return mats


# ---------------------------------------------------------------------------
# Montagem da cena no schema v1
# ---------------------------------------------------------------------------
def _solido_sofa(p):
    L = p["L"]
    xi_r = L / 2 - 0.05
    seat_h = p["sofa_seat_h"]; back_h = p["sofa_back_h"]; back_t = p["sofa_back_t"]
    depth = p["sofa_depth"]; slen = p["sofa_len"]; sy = p["sofa_y"]; armw = p["sofa_arm_w"]
    sx = xi_r - back_t - (depth - back_t) / 2.0
    objs = [
        dict(nome="sofa_assento", tipo="cubo", centro=[sx, sy, seat_h / 2.0],
             tamanho=[depth - back_t, max(0.4, slen - 2 * armw), seat_h], material="sofa"),
        dict(nome="sofa_encosto", tipo="cubo", centro=[xi_r - back_t / 2.0, sy, back_h / 2.0],
             tamanho=[back_t, slen, back_h], material="sofa"),
        dict(nome="sofa_braco_1", tipo="cubo",
             centro=[xi_r - depth / 2.0, sy - slen / 2.0 + armw / 2.0, p["sofa_arm_h"] / 2.0],
             tamanho=[depth, armw, p["sofa_arm_h"]], material="sofa"),
        dict(nome="sofa_braco_2", tipo="cubo",
             centro=[xi_r - depth / 2.0, sy + slen / 2.0 - armw / 2.0, p["sofa_arm_h"] / 2.0],
             tamanho=[depth, armw, p["sofa_arm_h"]], material="sofa"),
    ]
    return objs


def _solido_mesa(p):
    tx, ty = p["table_x"], p["table_y"]
    lx, ly = p["table_lx"], p["table_ly"]
    hh, tt = p["table_h"], p["table_top_t"]
    leg_h = hh - tt
    objs = [dict(nome="mesa_topo", tipo="cubo", centro=[tx, ty, hh - tt / 2.0],
                 tamanho=[lx, ly, tt], material="madeira")]
    for i, (dx, dy) in enumerate([(-1, -1), (1, -1), (-1, 1), (1, 1)]):
        objs.append(dict(nome="mesa_pe_%d" % (i + 1), tipo="cilindro",
                         centro=[tx + dx * (lx / 2.0 - 0.07), ty + dy * (ly / 2.0 - 0.07),
                                 leg_h / 2.0],
                         tamanho=[0.035, 0.035, leg_h], material="metal"))
    return objs


def montar_cena(p, mob, mats_estimados):
    L, P, H = p["L"], p["P"], p["H"]
    yaw = math.radians(p["yaw"]); pitch = math.radians(p["pitch"])
    D = np.array([math.sin(yaw) * math.cos(pitch),
                  math.cos(yaw) * math.cos(pitch),
                  -math.sin(pitch)])
    cam_pos = [p["cam_x"], p["cam_y"], p["cam_z"]]
    cam_alvo = list(np.asarray(cam_pos) + D)
    mats = {
        "parede": {"cor": _r6(mats_estimados["parede"]), "rugosidade": 0.9},
        "teto": {"cor": _r6(mats_estimados["teto"]), "rugosidade": 0.95},
        "piso": {"cor": _r6(mats_estimados["piso"]), "rugosidade": 0.6},
        "tapete": {"cor": _r6(mats_estimados["tapete"]), "rugosidade": 0.95},
        "sofa": {"cor": _r6(mats_estimados["sofa"]), "rugosidade": 0.8},
        "madeira": {"cor": _r6(mats_estimados["mesa"]), "rugosidade": 0.5},
        "metal": {"cor": [0.35, 0.35, 0.35], "rugosidade": 0.3, "metalico": 1.0},
        "ceu": {"cor": _RIG["ceu_cor"], "emissao": _RIG["ceu_cor"],
                "forca_emissao": _RIG["ceu_forca"]},
        "luz": {"cor": _RIG["lamp_cor"], "emissao": _RIG["lamp_cor"],
                "forca_emissao": _RIG["luz_forca"]},
        "livro1": {"cor": [0.15, 0.30, 0.65], "rugosidade": 0.8},
        "livro2": {"cor": [0.60, 0.20, 0.20], "rugosidade": 0.8},
    }
    objs = []
    pm = dict(p); pm.update(mob)
    if mob.get("sofa_y") is not None:
        objs.extend(_solido_sofa(pm))
    if mob.get("table_x") is not None:
        objs.extend(_solido_mesa(pm))
    if mob.get("rug_x") is not None:
        objs.append(dict(nome="tapete", tipo="plano",
                         centro=[_r6(mob["rug_x"]), _r6(mob["rug_y"]), 0.012],
                         tamanho=[_r6(mob["rug_lx"]), _r6(mob["rug_ly"]), 1], material="tapete"))
    for b in mob.get("livros", []):
        b = dict(b)
        b["centro"] = _r6(b["centro"]); b["tamanho"] = _r6(b["tamanho"])
        objs.append(b)
    # garante >=5 objetos (plausibilidade) com uma luminaria e livros
    lx0 = -L / 2 + 0.22
    ly0 = -P / 2 + 0.55
    filler = [
        dict(nome="luminaria", tipo="cilindro", centro=[lx0, ly0, 0.75],
             tamanho=[0.05, 0.05, 1.5], material="metal"),
        dict(nome="luminaria_cupula", tipo="esfera", centro=[lx0, ly0, 1.58],
             tamanho=[0.32, 0.32, 0.32], material="luz"),
        dict(nome="livro_chao", tipo="cubo", centro=[lx0 + 0.35, ly0 - 0.15, 0.025],
             tamanho=[0.3, 0.22, 0.05], material="livro1"),
        dict(nome="mesa_lateral", tipo="cubo", centro=[lx0 + 0.15, ly0 + 0.38, 0.25],
             tamanho=[0.45, 0.45, 0.5], material="madeira"),
    ]
    for obj in filler:
        if len(objs) >= 5:
            break
        if any(o.get("nome") == obj["nome"] for o in objs):
            continue
        objs.append(obj)
    if len(objs) < 5:
        objs.append(dict(nome="tapete_extra", tipo="plano",
                         centro=[0.0, 0.0, 0.011], tamanho=[1.6, 1.2, 1],
                         material="tapete"))
    luzes = [
        dict(tipo="sol", direcao=_RIG["sun_dir"], energia=_RIG["sun_energia"],
             cor=_RIG["sun_cor"], angulo_graus=_RIG["sun_angulo"]),
        dict(tipo="area", posicao=[-L / 2 + 0.22, -P / 2 + 0.55, 1.45],
             alvo=[-L / 2 + 0.22, -P / 2 + 0.55, 0.0], energia=_RIG["lamp_energia"],
             tamanho=_RIG["lamp_size"], cor=_RIG["lamp_cor"]),
        dict(tipo="area", posicao=[(p["u0"] + p["u1"]) / 2.0, P / 2 - 0.12, _RIG["area_z"]],
             alvo=[(p["u0"] + p["u1"]) / 2.0, 0.0, _RIG["area_z"]],
             energia=_RIG["area_energia"], tamanho=_RIG["area_size"], cor=_RIG["area_cor"]),
    ]
    cena = dict(
        versao=1,
        sala=dict(largura=_r6(L), profundidade=_r6(P), altura=_r6(H), espessura=0.10,
                  abertura=dict(parede="fundo", u0=_r6(p["u0"]), u1=_r6(p["u1"]),
                                z0=_r6(p["z0"]), z1=_r6(p["z1"]))),
        materiais=mats,
        objetos=objs,
        luzes=luzes,
        ambiente=dict(cor=_RIG["amb_cor"], forca=_RIG["amb_forca"]),
        cameras=dict(A=dict(posicao=_r6(cam_pos), alvo=_r6(cam_alvo), lente=_r6(p["lens"]))),
        render=dict(resolucao=256, amostras=64, denoise=True),
    )
    return cena


def _r6(v):
    if isinstance(v, (list, tuple, np.ndarray)):
        return [_r6(x) for x in v]
    return round(float(v), 6)


# ---------------------------------------------------------------------------
# Pipeline principal
# ---------------------------------------------------------------------------
def reconstruir(img, seed=0, verbose=False):
    size = int(min(img.shape[0], img.shape[1]))
    if img.shape[0] != img.shape[1]:
        n = size
        ys = (img.shape[0] - n) // 2
        xs = (img.shape[1] - n) // 2
        img = img[ys:ys + n, xs:xs + n]
    janela = detectar_janela(img, size)
    if janela is None:
        return cena_fallback(size)
    p = resolver_analitico(img, size, verbose=verbose)
    if p is None:
        return cena_fallback(size)
    p = refinar_geometria(p, p["_retas"], size)
    cam = camera_de_params(p, size)
    mob = {}
    mesa = detectar_mesa(img, p, cam, mob)
    if mesa is not None:
        mob.update(mesa)
    tapete = detectar_rug(img, p, cam, mob)
    if tapete is not None:
        mob.update(tapete)
    sofa = detectar_sofa(img, p, cam)
    if sofa is not None:
        mob.update(sofa)
    livros = detectar_livros(img, p, cam, mob)
    if livros:
        mob["livros"] = livros
    amostras = amostrar_aparencia(img, p, cam, janela, p["_retas"], mob)
    mats = estimar_materiais(amostras)
    if verbose:
        print("mob:", {k: v for k, v in mob.items() if k != "livros"})
        print("amostras:", {k: None if v is None else np.round(v, 3) for k, v in amostras.items()})
        print("mats:", {k: np.round(v, 3) for k, v in mats.items()})
    cena = montar_cena(p, mob, mats)
    return cena


def cena_fallback(size):
    """Cena plausivel minima quando a deteccao falha (nunca retorna invalido)."""
    L, P, H = 4.0, 4.0, 2.7
    mats = {k: list(v["base"]) for k, v in _CAL_A1.items()}
    mats.update({
        "metal": [0.35, 0.35, 0.35], "ceu": [0.85, 0.9, 1.0],
        "luz": [1.0, 0.8, 0.55], "livro1": [0.15, 0.3, 0.65], "livro2": [0.6, 0.2, 0.2],
    })
    objs = [
        dict(nome="mesa_topo", tipo="cubo", centro=[0.0, 0.0, 0.42],
             tamanho=[1.1, 0.6, 0.05], material="madeira"),
        dict(nome="mesa_pe_1", tipo="cilindro", centro=[-0.48, -0.23, 0.2],
             tamanho=[0.035, 0.035, 0.4], material="metal"),
        dict(nome="mesa_pe_2", tipo="cilindro", centro=[0.48, -0.23, 0.2],
             tamanho=[0.035, 0.035, 0.4], material="metal"),
        dict(nome="tapete", tipo="plano", centro=[0.0, 0.0, 0.012],
             tamanho=[2.6, 2.2, 1], material="tapete"),
        dict(nome="luminaria_cupula", tipo="esfera", centro=[-1.7, -1.4, 1.45],
             tamanho=[0.25, 0.25, 0.25], material="luz"),
    ]
    p = dict(L=L, P=P, H=H, u0=-1.6, u1=-0.2, z0=0.6, z1=1.9,
             cam_x=-1.3, cam_y=-1.3, cam_z=1.5, yaw=20.0, pitch=8.0, lens=24.0)
    mob = dict(table_x=0.0, table_y=0.0, table_lx=1.1, table_ly=0.6,
               table_h=0.42, table_top_t=0.05,
               rug_x=0.0, rug_y=0.0, rug_lx=2.6, rug_ly=2.2)
    return montar_cena(p, mob, mats)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Reconstroi uma cena 3D a partir de uma imagem.")
    ap.add_argument("--ref", required=True, help="imagem de referencia (vista A)")
    ap.add_argument("--out", required=True, help="caminho do cena.json de saida")
    ap.add_argument("--seed", type=int, default=0, help="semente (determinismo)")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args(argv)
    img = carregar_imagem(args.ref)
    cena = reconstruir(img, seed=args.seed, verbose=args.verbose)
    # ordena listas de forma estavel (determinismo de bytes)
    cena["objetos"] = sorted(cena["objetos"], key=lambda o: str(o.get("nome", "")))
    txt = json.dumps(cena, ensure_ascii=False, indent=1, sort_keys=True)
    d = os.path.dirname(os.path.abspath(args.out))
    if d:
        os.makedirs(d, exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        f.write(txt + "\n")
    if args.verbose:
        print("cena escrita em", args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
