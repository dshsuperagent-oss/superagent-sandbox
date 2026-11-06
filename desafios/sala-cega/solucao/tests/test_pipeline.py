# -*- coding: utf-8 -*-
"""Testes de ponta a ponta do CLI e do schema (sem Blender)."""
import importlib.util
import json
import math
import os
import subprocess
import sys
import tempfile
import time
import unittest

import numpy as np

AQUI = os.path.dirname(os.path.abspath(__file__))
SOLUCAO = os.path.dirname(AQUI)
KIT = os.path.dirname(SOLUCAO)
FIXTURE_A = os.path.join(AQUI, "fixtures", "sala_sintetica_A.png")
FIXTURE_B = os.path.join(AQUI, "fixtures", "sala_sintetica_B.png")
sys.path.insert(0, SOLUCAO)

import reconstruir as R


def _carregar_schema_kit():
    caminho = os.path.join(KIT, "schema.py")
    if not os.path.exists(caminho):
        return None
    spec = importlib.util.spec_from_file_location("schema_kit", caminho)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _validar_basico(cena):
    """Checagens de plausibilidade/schema equivalentes as do BRIEF."""
    err = []
    if cena.get("versao") != 1:
        err.append("versao")
    sala = cena["sala"]
    for k in ("largura", "profundidade", "altura"):
        if not (2.0 <= float(sala[k]) <= 12.0 if k != "altura" else 2.0 <= float(sala[k]) <= 5.0):
            err.append("sala." + k)
    ab = sala["abertura"]
    if ab["parede"] not in ("fundo", "frente", "esquerda", "direita"):
        err.append("parede")
    if not (ab["u0"] < ab["u1"] and ab["z0"] < ab["z1"] <= sala["altura"] - 0.05):
        err.append("abertura")
    if len(cena["objetos"]) < 5:
        err.append("objetos<5")
    L, P, H = float(sala["largura"]), float(sala["profundidade"]), float(sala["altura"])
    for o in cena["objetos"]:
        c = o["centro"]; t = o["tamanho"]
        for v in c + t:
            if not math.isfinite(float(v)):
                err.append("nan")
        if min(t) <= 0:
            err.append("tamanho")
        if not (-L / 2 - 0.11 <= c[0] <= L / 2 + 0.11 and
                -P / 2 - 0.11 <= c[1] <= P / 2 + 0.11):
            err.append("objeto fora: " + str(o.get("nome")))
        if c[2] - t[2] / 2 < -0.01:
            err.append("abaixo do piso: " + str(o.get("nome")))
    if not cena.get("luzes"):
        err.append("luzes")
    cam = cena["cameras"]["A"]
    cx, cy, cz = cam["posicao"]
    if not (-L / 2 < cx < L / 2 and -P / 2 < cy < P / 2 and 0 < cz < H):
        err.append("camera fora")
    for k in ("posicao", "alvo"):
        if len(cam[k]) != 3:
            err.append("camera")
    return err


class TestReconstrucao(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cena = R.reconstruir(R.carregar_imagem(FIXTURE_A), seed=0)

    def test_schema_basico(self):
        self.assertEqual(_validar_basico(self.cena), [])

    def test_schema_do_kit(self):
        kit = _carregar_schema_kit()
        if kit is None:
            self.skipTest("schema.py do kit nao encontrado")
        self.assertEqual(kit.validar(self.cena), [])

    def test_cena_dentro_dos_limites_temporais(self):
        t = time.time()
        R.reconstruir(R.carregar_imagem(FIXTURE_A), seed=0)
        self.assertLess(time.time() - t, 120.0)

    def test_geometria_aproximada_em_cena_sintetica(self):
        # verdade: L=3.89, P=4.05, H=2.71, janela u0=-1.49/u1=-0.22, z0=0.87
        cena = R.reconstruir(R.carregar_imagem(FIXTURE_B), seed=0)
        sala = cena["sala"]
        self.assertAlmostEqual(sala["altura"], 2.70, places=3)
        self.assertTrue(3.0 < sala["largura"] < 5.2, sala["largura"])
        self.assertTrue(2.8 < sala["profundidade"] < 5.2, sala["profundidade"])
        ab = sala["abertura"]
        self.assertTrue(-2.0 < ab["u0"] < -0.8, ab["u0"])
        self.assertTrue(0.3 < ab["z0"] < 1.2, ab["z0"])
        self.assertTrue(1.5 < ab["z1"] < 2.5, ab["z1"])

    def test_sem_nan(self):
        txt = json.dumps(self.cena)
        self.assertNotIn("NaN", txt)
        self.assertNotIn("Infinity", txt)

    def test_orientacao_do_mundo(self):
        # convencao: sofa na parede do fundo; a abertura fica numa lateral
        cena = R.reconstruir(R.carregar_imagem(FIXTURE_B), seed=0)
        self.assertIn(cena["sala"]["abertura"]["parede"], ("esquerda", "direita"))


class TestCLI(unittest.TestCase):
    def _rodar(self, out, seed=0):
        return subprocess.run([sys.executable, os.path.join(SOLUCAO, "reconstruir.py"),
                               "--ref", FIXTURE_A, "--out", out, "--seed", str(seed)],
                              cwd=SOLUCAO, capture_output=True, text=True)

    def test_cli_gera_json_valido_e_deterministico(self):
        with tempfile.TemporaryDirectory() as d:
            a = os.path.join(d, "a.json")
            b = os.path.join(d, "b.json")
            ra = self._rodar(a, seed=0)
            rb = self._rodar(b, seed=7)
            self.assertEqual(ra.returncode, 0, ra.stderr)
            self.assertEqual(rb.returncode, 0, rb.stderr)
            with open(a, "rb") as f:
                da = f.read()
            with open(b, "rb") as f:
                db = f.read()
            self.assertEqual(da, db, "saida deve ser deterministica (seed nao muda bytes)")
            cena = json.loads(da.decode("utf-8"))
            self.assertEqual(_validar_basico(cena), [])


class TestFallback(unittest.TestCase):
    def test_imagem_sem_janela(self):
        cena = R.cena_fallback(256)
        self.assertEqual(_validar_basico(cena), [])


if __name__ == "__main__":
    unittest.main()
