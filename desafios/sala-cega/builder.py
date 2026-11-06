# -*- coding: utf-8 -*-
"""Builder do Desafio da Sala Cega.

Le uma cena no schema `cena.json` (v1), constroi no Blender e renderiza.
Uso:
  blender -b -P builder.py -- --spec cena.json --out saida.png [--camera A]
                                  [--camera-json pose.json] [--resolucao 256]
                                  [--amostras 64] [--size-x 1] [--size-y 1]
O `--camera-json` recebe {"posicao":[x,y,z],"alvo":[x,y,z],"lente":24} e substitui
a camera escolhida (usado para a vista escondida B).
Convencoes: sala centrada em X/Y no chao z=0; parede "fundo" em y=+prof/2;
"abertura.u" = x para fundo/frente e y para esquerda/direita. Unidades: metros.
"""
import argparse
import json
import math
import os
import sys

import bpy
from mathutils import Vector


def log(msg):
    print("SALA-CEGA|" + str(msg), flush=True)


def parse_args():
    argv = sys.argv
    argv = argv[argv.index("--") + 1:] if "--" in argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--spec", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--camera", default="A")
    p.add_argument("--camera-json", default=None)
    p.add_argument("--resolucao", type=int, default=0)
    p.add_argument("--amostras", type=int, default=0)
    p.add_argument("--exposure", type=float, default=0.0)
    return p.parse_args(argv)


def vec(value, default=(0.0, 0.0, 0.0)):
    if value is None:
        return Vector(default)
    if isinstance(value, (int, float)):
        return Vector((float(value),) * 3)
    return Vector([float(v) for v in value])


def rad(deg):
    return math.radians(deg)


def material(nome, dados, materiais):
    mat = bpy.data.materials.new(nome)
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = nodes.get("Principled BSDF")
    cor = dados.get("cor", [0.8, 0.8, 0.8])
    bsdf.inputs["Base Color"].default_value = (cor[0], cor[1], cor[2], 1.0)
    bsdf.inputs["Roughness"].default_value = float(dados.get("rugosidade", 0.5))
    bsdf.inputs["Metallic"].default_value = float(dados.get("metalico", 0.0))
    emissao = dados.get("emissao")
    if emissao:
        bsdf.inputs["Emission Color"].default_value = (emissao[0], emissao[1], emissao[2], 1.0)
        bsdf.inputs["Emission Strength"].default_value = float(dados.get("forca_emissao", 1.0))
    if dados.get("transmissao"):
        bsdf.inputs["Transmission Weight"].default_value = float(dados["transmissao"])
    materiais[nome] = mat
    return mat


def create_primitive(tipo, loc, escala, rot_deg, mat, smooth=False):
    if tipo == "cubo":
        bpy.ops.mesh.primitive_cube_add(size=1.0, location=loc)
    elif tipo == "esfera":
        bpy.ops.mesh.primitive_uv_sphere_add(segments=48, ring_count=24, radius=0.5, location=loc)
    elif tipo == "cilindro":
        bpy.ops.mesh.primitive_cylinder_add(vertices=48, radius=0.5, depth=1.0, location=loc)
    elif tipo == "plano":
        bpy.ops.mesh.primitive_plane_add(size=1.0, location=loc)
    else:
        raise ValueError("tipo desconhecido: " + str(tipo))
    obj = bpy.context.object
    obj.scale = escala
    obj.rotation_euler = (rad(rot_deg[0]), rad(rot_deg[1]), rad(rot_deg[2]))
    if mat is not None:
        obj.data.materials.append(mat)
    if smooth:
        for poly in obj.data.polygons:
            poly.use_smooth = True
    return obj


def parede_painel(nome, centro, escala, mat):
    return create_primitive("cubo", centro, escala, (0, 0, 0), mat)


def build_sala(sala, materiais, altura_painel=0.0):
    largura = float(sala["largura"])
    prof = float(sala["profundidade"])
    altura = float(sala["altura"])
    t = float(sala.get("espessura", 0.10))
    mat = materiais.get("parede")
    teto_mat = materiais.get("teto", mat)
    piso_mat = materiais.get("piso", mat)

    # piso e teto
    create_primitive("plano", (0, 0, 0), (largura, prof, 1), (0, 0, 0), piso_mat)
    create_primitive("plano", (0, 0, altura), (largura, prof, 1), (0, 0, 0), teto_mat)

    abertura = sala.get("abertura") or {}
    parede = abertura.get("parede")
    u0 = float(abertura.get("u0", 0.0))
    u1 = float(abertura.get("u1", 0.0))
    z0 = float(abertura.get("z0", 0.4))
    z1 = float(abertura.get("z1", 1.8))

    def painel_horizontal(y, x0, x1, za, zb):
        if x1 - x0 <= 1e-6 or zb - za <= 1e-6:
            return
        parede_painel("parede", ((x0 + x1) / 2, y, (za + zb) / 2), (x1 - x0, t, zb - za), mat)

    def painel_vertical(x, y0, y1, za, zb):
        if y1 - y0 <= 1e-6 or zb - za <= 1e-6:
            return
        parede_painel("parede", (x, (y0 + y1) / 2, (za + zb) / 2), (t, y1 - y0, zb - za), mat)

    yb, yf = prof / 2, -prof / 2
    xl, xr = -largura / 2, largura / 2

    if parede in ("fundo", "frente"):
        y = yb if parede == "fundo" else yf
        painel_horizontal(y, xl, u0, 0, altura)
        painel_horizontal(y, u1, xr, 0, altura)
        painel_horizontal(y, u0, u1, 0, z0)
        painel_horizontal(y, u0, u1, z1, altura)
    else:
        painel_horizontal(yb, xl, xr, 0, altura)
        painel_horizontal(yf, xl, xr, 0, altura)

    if parede in ("esquerda", "direita"):
        x = xl if parede == "esquerda" else xr
        painel_vertical(x, yf, u0, 0, altura) if False else None
        painel_vertical(x, yf, u0, 0, altura)
        painel_vertical(x, u1, yb, 0, altura)
        painel_vertical(x, u0, u1, 0, z0)
        painel_vertical(x, u0, u1, z1, altura)
    else:
        painel_vertical(xl, yf, yb, 0, altura)
        painel_vertical(xr, yf, yb, 0, altura)

    # ceu visto pela abertura
    if parede in ("fundo", "frente") and "ceu" in materiais:
        y = (yb + t) if parede == "fundo" else (yf - t)
        cx = (u0 + u1) / 2
        cz = (z0 + z1) / 2
        create_primitive("plano", (cx, y, cz), (max(u1 - u0, 0.2) + 0.6, max(z1 - z0, 0.2) + 0.6, 1),
                         (90, 0, 0) if parede == "fundo" else (-90, 0, 0), materiais["ceu"])
    elif parede in ("esquerda", "direita") and "ceu" in materiais:
        x = (xl - t) if parede == "esquerda" else (xr + t)
        cy = (u0 + u1) / 2
        cz = (z0 + z1) / 2
        create_primitive("plano", (x, cy, cz), (max(u1 - u0, 0.2) + 0.6, max(z1 - z0, 0.2) + 0.6, 1),
                         (90, 0, 90) if parede == "esquerda" else (-90, 0, 90), materiais["ceu"])


def add_sun(dados):
    bpy.ops.object.light_add(type="SUN", location=(0, 0, 3))
    obj = bpy.context.object
    direcao = vec(dados.get("direcao", [0.3, -0.8, -0.5])).normalized()
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = direcao.to_track_quat("-Z", "Y")
    obj.data.energy = float(dados.get("energia", 3.0))
    obj.data.angle = rad(float(dados.get("angulo_graus", 1.0)))
    cor = dados.get("cor", [1.0, 1.0, 1.0])
    obj.data.color = (cor[0], cor[1], cor[2])
    return obj


def add_area(dados):
    pos = vec(dados.get("posicao", [0, 0, 2]))
    bpy.ops.object.light_add(type="AREA", location=pos)
    obj = bpy.context.object
    alvo = vec(dados.get("alvo", [0, 0, 0]))
    direcao = (alvo - pos).normalized()
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = direcao.to_track_quat("-Z", "Y")
    obj.data.energy = float(dados.get("energia", 100.0))
    obj.data.size = float(dados.get("tamanho", 0.5))
    cor = dados.get("cor", [1.0, 1.0, 1.0])
    obj.data.color = (cor[0], cor[1], cor[2])
    return obj


def add_point(dados):
    pos = vec(dados.get("posicao", [0, 0, 2]))
    bpy.ops.object.light_add(type="POINT", location=pos)
    obj = bpy.context.object
    obj.data.energy = float(dados.get("energia", 50.0))
    obj.data.shadow_soft_size = float(dados.get("raio", 0.1))
    cor = dados.get("cor", [1.0, 1.0, 1.0])
    obj.data.color = (cor[0], cor[1], cor[2])
    return obj


def add_camera(dados):
    pos = vec(dados.get("posicao", [0, -2, 1.5]))
    alvo = vec(dados.get("alvo", [0, 0, 1.0]))
    bpy.ops.object.camera_add(location=pos)
    obj = bpy.context.object
    direcao = (alvo - pos).normalized()
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = direcao.to_track_quat("-Z", "Y")
    obj.data.lens = float(dados.get("lente", 24.0))
    obj.data.sensor_width = float(dados.get("sensor", 36.0))
    return obj


def main():
    args = parse_args()
    with open(args.spec, "r", encoding="utf-8") as f:
        spec = json.load(f)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene

    # materiais
    mats = {}
    definicoes = {"parede": {"cor": [0.8, 0.8, 0.78], "rugosidade": 0.9},
                  "teto": {"cor": [0.9, 0.9, 0.88], "rugosidade": 0.95},
                  "piso": {"cor": [0.45, 0.33, 0.22], "rugosidade": 0.5}}
    definicoes.update(spec.get("materiais") or {})
    for nome, dados in definicoes.items():
        material(nome, dados or {}, mats)

    # sala
    build_sala(spec.get("sala") or {"largura": 4, "profundidade": 3.5, "altura": 2.6}, mats)

    # objetos
    criados = 0
    for item in spec.get("objetos") or []:
        nome = str(item.get("nome", "obj"))
        mat = mats.get(item.get("material"))
        obj = create_primitive(
            str(item.get("tipo", "cubo")),
            vec(item.get("centro", [0, 0, 0.5])),
            vec(item.get("tamanho", [0.5, 0.5, 0.5])),
            item.get("rotacao_deg", [0, 0, 0]),
            mat,
            smooth=str(item.get("tipo")) in ("esfera", "cilindro"),
        )
        obj.name = nome
        criados += 1
    log("objetos=%d" % criados)

    # luzes
    for luz in spec.get("luzes") or []:
        tipo = str(luz.get("tipo", "area"))
        if tipo == "sol":
            add_sun(luz)
        elif tipo == "area":
            add_area(luz)
        elif tipo == "ponto":
            add_point(luz)
        else:
            log("luz ignorada: " + tipo)

    # ambiente
    amb = spec.get("ambiente") or {}
    mundo = bpy.data.worlds.new("mundo")
    sc.world = mundo
    mundo.use_nodes = True
    bg = mundo.node_tree.nodes.get("Background")
    cor = amb.get("cor", [0.55, 0.7, 0.9])
    bg.inputs[0].default_value = (cor[0], cor[1], cor[2], 1.0)
    bg.inputs[1].default_value = float(amb.get("forca", 0.3))

    # camera
    cameras = spec.get("cameras") or {}
    escolhida = cameras.get(args.camera) or cameras.get("A") or {}
    if args.camera_json:
        with open(args.camera_json, "r", encoding="utf-8") as f:
            escolhida = json.load(f)
    cam = add_camera(escolhida)
    sc.camera = cam

    # render
    render = spec.get("render") or {}
    res = args.resolucao or int(render.get("resolucao", 256))
    amostras = args.amostras or int(render.get("amostras", 64))
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = amostras
    sc.cycles.use_denoising = bool(render.get("denoise", True))
    sc.cycles.seed = 0
    sc.cycles.use_animated_seed = False
    sc.render.resolution_x = res
    sc.render.resolution_y = res
    sc.render.resolution_percentage = 100
    sc.render.image_settings.file_format = "PNG"
    sc.render.film_transparent = False
    sc.view_settings.view_transform = "AgX"
    sc.view_settings.look = "None"
    sc.view_settings.exposure = float(args.exposure)
    sc.render.filepath = args.out
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    bpy.ops.render.render(write_still=True)
    log("render_ok=" + os.path.abspath(args.out))


if __name__ == "__main__":
    try:
        main()
    except Exception as erro:
        log("erro=" + str(erro))
        raise
