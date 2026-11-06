# -*- coding: utf-8 -*-
"""Testes das primitivas geometricas do reconstruir.py (sem Blender)."""
import math
import os
import sys
import unittest

import numpy as np

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(AQUI))

import reconstruir as R


class TestCamera(unittest.TestCase):
    def test_centro_da_imagem(self):
        cam = R.look_at((0.0, -3.0, 1.0), (0.0, 0.0, 1.0), lente=24.0, size=256)
        xy, w = R.projetar([[0.0, 0.0, 1.0]], cam)
        self.assertGreater(float(w[0]), 0.0)
        self.assertAlmostEqual(float(xy[0, 0]), 128.0, places=6)
        self.assertAlmostEqual(float(xy[0, 1]), 128.0, places=6)

    def test_focal_de_24mm(self):
        cam = R.look_at((0.0, 0.0, 1.0), (0.0, 1.0, 1.0), lente=24.0, size=256)
        self.assertAlmostEqual(cam["f"], 256.0 * 24.0 / 36.0, places=9)

    def test_raio_plano_recupera_ponto(self):
        cam = R.look_at((-1.0, -2.0, 1.5), (0.3, 0.5, 0.9), lente=24.0, size=256)
        P = np.array([[0.4, 0.2, 0.0], [-0.8, 1.1, 0.0], [0.9, -0.3, 0.0]])
        xy, w = R.projetar(P, cam)
        for i in range(len(P)):
            self.assertGreater(float(w[i]), 0.0)
            Q = R.ponto_plano((xy[i, 0], xy[i, 1]), 0.0, cam)
            self.assertIsNotNone(Q)
            np.testing.assert_allclose(Q, P[i], atol=2e-3)


class TestRetasEVPs(unittest.TestCase):
    def test_intersecao_horizontal_vertical(self):
        x, y = R.interseccao_hv((0.5, 10.0), (-2.0, 3.0))
        self.assertAlmostEqual(y, 0.5 * x + 10.0, places=9)
        self.assertAlmostEqual(x, -2.0 * y + 3.0, places=9)

    def test_vp_de_retas_concorrentes(self):
        # tres retas passando por (40, 70)
        retas = [R.reta_h(0.5, 70 - 0.5 * 40),
                 R.reta_h(-0.25, 70 + 0.25 * 40),
                 R.reta_v(2.0, 40 - 2.0 * 70)]
        vp = R.vp_de_retas(retas)
        self.assertAlmostEqual(float(vp[0]), 40.0, places=6)
        self.assertAlmostEqual(float(vp[1]), 70.0, places=6)

    def test_rotacao_de_vps_ortogonais(self):
        # camera sintetica conhecida: projeta as direcoes dos eixos e recupera R
        cam = R.look_at((-1.0, -1.0, 1.5), (0.2, 0.6, 0.9), lente=24.0, size=256)
        vx = np.array([cam["cx"] + cam["f"] * cam["r"][0] / cam["D"][0] * 0, 0])
        # pontos no infinito: projeta direcao do eixo +X e +Z
        def vp(direcao):
            d = np.asarray(direcao, float)
            d = d / np.linalg.norm(d)
            return np.array([cam["cx"] + cam["f"] * (cam["r"] @ d) / (cam["D"] @ d),
                             cam["cy"] + cam["f"] * (cam["d"] @ d) / (cam["D"] @ d)])
        vpx = vp([1.0, 0.0, 0.0])
        vpz = vp([0.0, 0.0, 1.0])
        Rw = R.rotacao_de_vps(vpx, vpz, cam["f"], 256)
        self.assertIsNotNone(Rw)
        # R leva o mundo para a camera: a direcao de visao D vira +Z
        np.testing.assert_allclose(Rw @ cam["D"], np.array([0.0, 0.0, 1.0]), atol=2e-2)
        np.testing.assert_allclose(Rw @ Rw.T, np.eye(3), atol=1e-6)
        self.assertAlmostEqual(float(np.linalg.det(Rw)), 1.0, places=6)


class TestHomografia(unittest.TestCase):
    def test_homografia_retangulo(self):
        # camera olhando para uma parede em y=3; retangulo de 2 x 1 m
        cam = R.look_at((-0.4, -0.6, 1.5), (0.1, 3.0, 1.1), lente=24.0, size=256)
        pts = np.array([[0.0, 3.0, 0.0], [2.0, 3.0, 0.0],
                        [2.0, 3.0, 1.0], [0.0, 3.0, 1.0]])
        xy, w = R.projetar(pts, cam)
        self.assertTrue(np.all(w > 0))
        H = R.homografia([(0, 0), (1, 0), (1, 1), (0, 1)], [tuple(p) for p in xy])
        # H leva o quadrado unitario aos pixels
        for (u, v), esperado in zip([(0, 0), (1, 0), (1, 1), (0, 1)], xy):
            h = H @ np.array([u, v, 1.0])
            h = h / h[2]
            np.testing.assert_allclose(h[:2], esperado, atol=1e-6)

    def test_decompor_janela_recupera_proporcao(self):
        cam = R.look_at((-1.0, -1.2, 1.5), (0.2, 1.0, 1.0), lente=24.0, size=256)
        w, h = 1.6, 1.2
        pts = np.array([[0.0, 3.0, 0.0], [w, 3.0, 0.0], [w, 3.0, h], [0.0, 3.0, h]])
        xy, _ = R.projetar(pts, cam)
        quad = xy[[3, 2, 1, 0]]  # TL,TR,BR,BL
        vpx = np.array([cam["cx"] + cam["f"] * cam["r"][0] / cam["D"][0], 0.0])
        vpx[1] = cam["cy"] + cam["f"] * cam["d"][0] / cam["D"][0]
        vpz = np.array([cam["cx"] + cam["f"] * cam["r"][2] / cam["D"][2],
                        cam["cy"] + cam["f"] * cam["d"][2] / cam["D"][2]])
        Rw = R.rotacao_de_vps(vpx, vpz, cam["f"], 256)
        dec = R.decompor_janela(quad, cam["f"], Rw, 256)
        self.assertIsNotNone(dec)
        self.assertAlmostEqual(dec["h"] / dec["w"], h / w, places=2)


if __name__ == "__main__":
    unittest.main()
