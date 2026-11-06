# -*- coding: utf-8 -*-
"""Validador do schema `cena.json` (v1) do Desafio da Sala Cega.

Python puro (sem bpy, sem numpy): serve tanto para o concorrente conferir a
propria entrega quanto para o avaliador. Uso:
  python schema.py cena.json
Sai 0 se valida, 1 se ha erro (e imprime a lista).
"""
import json
import math
import sys

TIPOS = {"cubo", "esfera", "cilindro", "plano"}
PAREDES = {"fundo", "frente", "esquerda", "direita"}
CHAVES_OBJETO = {"nome", "tipo", "centro", "tamanho", "rotacao_deg", "material"}
CHAVES_MATERIAL = {"cor", "rugosidade", "metalico", "emissao", "forca_emissao", "transmissao"}


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(float(v))


def _tri(v):
    return isinstance(v, list) and len(v) == 3 and all(_num(x) for x in v)


def _dentro(v, lo, hi):
    return _num(v) and lo <= float(v) <= hi


def validar(cena):
    """Retorna a lista de erros (vazia = valido)."""
    erros = []
    if not isinstance(cena, dict):
        return ["a raiz deve ser um objeto JSON"]
    if cena.get("versao") != 1:
        erros.append("versao deve ser 1")

    sala = cena.get("sala")
    if not isinstance(sala, dict):
        erros.append("sala ausente")
    else:
        for campo, lo, hi in (("largura", 2.0, 12.0), ("profundidade", 2.0, 12.0), ("altura", 2.0, 5.0)):
            if not _dentro(sala.get(campo), lo, hi):
                erros.append("sala.%s deve estar entre %s e %s" % (campo, lo, hi))
        esp = sala.get("espessura", 0.10)
        if not _dentro(esp, 0.02, 0.5):
            erros.append("sala.espessura deve estar entre 0.02 e 0.5")
        ab = sala.get("abertura")
        if not isinstance(ab, dict):
            erros.append("sala.abertura ausente")
        else:
            if ab.get("parede") not in PAREDES:
                erros.append("sala.abertura.parede invalida")
            for campo in ("u0", "u1", "z0", "z1"):
                if not _num(ab.get(campo)):
                    erros.append("sala.abertura.%s deve ser numero" % campo)
            if _num(ab.get("u0")) and _num(ab.get("u1")) and ab["u0"] >= ab["u1"]:
                erros.append("sala.abertura: u0 deve ser menor que u1")
            if _num(ab.get("z0")) and _num(ab.get("z1")) and ab["z0"] >= ab["z1"]:
                erros.append("sala.abertura: z0 deve ser menor que z1")
            if _num(ab.get("z1")) and _num(sala.get("altura")) and ab["z1"] > sala["altura"] - 0.05:
                erros.append("sala.abertura: z1 deve ficar abaixo do teto")

    mats = cena.get("materiais")
    if not isinstance(mats, dict) or not mats:
        erros.append("materiais deve ser um objeto com pelo menos 1 material")
    else:
        for nome, mat in mats.items():
            if not isinstance(mat, dict):
                erros.append("material %r deve ser objeto" % nome)
                continue
            extras = set(mat) - CHAVES_MATERIAL
            if extras:
                erros.append("material %r tem chaves proibidas: %s" % (nome, sorted(extras)))
            if not _tri(mat.get("cor")):
                erros.append("material %r: cor deve ser [r,g,b]" % nome)
            else:
                for c in mat["cor"]:
                    if not _dentro(c, 0.0, 1.0):
                        erros.append("material %r: cor fora de 0..1" % nome)
            if "rugosidade" in mat and not _dentro(mat["rugosidade"], 0.0, 1.0):
                erros.append("material %r: rugosidade fora de 0..1" % nome)
            if "metalico" in mat and not _dentro(mat["metalico"], 0.0, 1.0):
                erros.append("material %r: metalico fora de 0..1" % nome)
            if "forca_emissao" in mat and not _dentro(mat["forca_emissao"], 0.0, 60.0):
                erros.append("material %r: forca_emissao fora de 0..60" % nome)

    objs = cena.get("objetos")
    if not isinstance(objs, list) or not objs:
        erros.append("objetos deve ser uma lista com pelo menos 1 item")
    else:
        for i, obj in enumerate(objs):
            if not isinstance(obj, dict):
                erros.append("objetos[%d] deve ser objeto" % i)
                continue
            extras = set(obj) - CHAVES_OBJETO
            if extras:
                erros.append("objetos[%d] tem chaves proibidas: %s" % (i, sorted(extras)))
            if obj.get("tipo") not in TIPOS:
                erros.append("objetos[%d].tipo invalido: %r" % (i, obj.get("tipo")))
            if not _tri(obj.get("centro")):
                erros.append("objetos[%d].centro deve ser [x,y,z]" % i)
            if not _tri(obj.get("tamanho")) or any(float(v) <= 0 for v in obj["tamanho"]):
                erros.append("objetos[%d].tamanho deve ser [x,y,z] positivo" % i)
            if not isinstance(obj.get("material"), str) or obj["material"] not in (mats or {}):
                erros.append("objetos[%d].material inexistente" % i)
            if "rotacao_deg" in obj and not _tri(obj["rotacao_deg"]):
                erros.append("objetos[%d].rotacao_deg invalido" % i)

    cams = cena.get("cameras")
    if not isinstance(cams, dict) or "A" not in cams:
        erros.append("cameras.A ausente")
    else:
        for nome, cam in cams.items():
            if not isinstance(cam, dict):
                erros.append("camera %r deve ser objeto" % nome)
                continue
            if not _tri(cam.get("posicao")):
                erros.append("camera %r: posicao invalida" % nome)
            if not _tri(cam.get("alvo")):
                erros.append("camera %r: alvo invalido" % nome)
            if not _dentro(cam.get("lente", 24.0), 10.0, 120.0):
                erros.append("camera %r: lente fora de 10..120 mm" % nome)

    luzes = cena.get("luzes")
    if not isinstance(luzes, list) or not luzes:
        erros.append("luzes deve ser uma lista com pelo menos 1 item")
    else:
        for i, luz in enumerate(luzes):
            if not isinstance(luz, dict):
                erros.append("luzes[%d] deve ser objeto" % i)
                continue
            tipo = luz.get("tipo")
            if tipo not in ("sol", "area", "ponto"):
                erros.append("luzes[%d].tipo invalido: %r" % (i, tipo))
                continue
            if tipo == "sol":
                if not _tri(luz.get("direcao")):
                    erros.append("luzes[%d] sol: direcao invalida" % i)
            else:
                if not _tri(luz.get("posicao")):
                    erros.append("luzes[%d]: posicao invalida" % i)
            if not _dentro(luz.get("energia", 100.0), 0.0, 5000.0):
                erros.append("luzes[%d]: energia fora de 0..5000" % i)

    amb = cena.get("ambiente")
    if amb is not None:
        if not isinstance(amb, dict):
            erros.append("ambiente deve ser objeto")
        else:
            if "cor" in amb and not _tri(amb["cor"]):
                erros.append("ambiente.cor invalida")
            if "forca" in amb and not _dentro(amb["forca"], 0.0, 5.0):
                erros.append("ambiente.forca fora de 0..5")

    return erros


def main():
    if len(sys.argv) != 2:
        print("uso: python schema.py cena.json")
        return 2
    with open(sys.argv[1], "r", encoding="utf-8") as f:
        cena = json.load(f)
    erros = validar(cena)
    if erros:
        print("INVALIDO (%d erro(s)):" % len(erros))
        for e in erros[:40]:
            print(" -", e)
        return 1
    print("VALIDO")
    return 0


if __name__ == "__main__":
    sys.exit(main())
