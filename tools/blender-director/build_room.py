#!/usr/bin/env python3
"""build_room.py — constrói e renderiza a sala do Blender Director v3.

Roda *dentro* do Blender, em background:

    blender -b --python-exit-code 1 -P tools/blender-director/build_room.py -- \\
        --room examples/room-living.json --out runs/sala --stage preview \\
        --preview-index 1 --progress-json

O script é **aditivo** à v1/v2: reaproveita os helpers estáveis do `build.py`
(materiais PBR, configuração de render/color management, câmera, luzes e
eventos JSON Lines) e acrescenta o que a v3 exige:

- paredes medidas com **aberturas recortadas por boolean** (EXACT);
- esquadrias, vidro e sacada gerados a partir do room plan;
- mobiliário em blocos com bevel, para o passe de graybox;
- importação de assets `.blend`/`.glTF` com escala/posição/rotação, "snap" no
  piso e registro de licença no manifesto;
- light rig por preset (`day`, `dusk`, `night`) com sol (W/m²), HDRI, luz de
  preenchimento da janela e luminárias internas em watts;
- `--dry-run`: valida e resolve o plano **sem Blender**, emitindo o JSON que o
  teste e2e e o `assets.js` comparam.

Qualquer mensagem humana vai para o stderr; o stdout é reservado para eventos
JSON Lines (o mesmo contrato do `build.py`).

Não há Blender no CI deste repositório. O modo `--dry-run` cobre a validação e
a geometria resolvida; o e2e sem Blender exercita o restante do pipeline.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import math
import os
import sys
import time
import traceback

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

try:  # pragma: no cover - só existe dentro do Blender
    import bpy
    from mathutils import Vector
except ImportError:  # permite `python3 build_room.py --dry-run`
    bpy = None
    Vector = None


def _load_director():
    """Carrega o build.py da v1 como módulo, sem executar o main."""
    path = os.path.join(SCRIPT_DIR, "build.py")
    spec = importlib.util.spec_from_file_location("director_build_v1", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


director = _load_director()

SCHEMA_VERSION = 1
SIDES = ("north", "south", "east", "west")
PRESET_ALIASES = {
    "day": "day",
    "dia": "day",
    "dusk": "dusk",
    "fim-de-tarde": "dusk",
    "fim de tarde": "dusk",
    "sunset": "dusk",
    "night": "night",
    "noite": "night",
}
PRESET_NAMES = ("day", "dusk", "night")
LICENSES = {
    "CC0-1.0",
    "CC-BY-2.0",
    "CC-BY-3.0",
    "CC-BY-4.0",
    "CC-BY-SA-3.0",
    "CC-BY-SA-4.0",
    "Public-Domain",
}
MATERIAL_KEYS = {
    "baseColor",
    "metallic",
    "roughness",
    "ior",
    "transmission",
    "subsurface",
    "coat",
    "sheen",
    "anisotropy",
    "emission",
    "normal",
    "textures",
}
DEFAULTS = {
    "wallThickness": 0.12,
    "floorThickness": 0.1,
    "ceilingThickness": 0.1,
    "frameProfile": 0.05,
    "frameDepth": 0.07,
}

LIMITS = {
    "maxFurniture": 240,
    "maxAssets": 64,
    "maxFixtures": 24,
    "maxOpenings": 16,
    "maxMaterials": 64,
}


class PlanError(RuntimeError):
    """Room plan inválido ou impossível de construir."""


# ---------------------------------------------------------------------------
# Validação (espelha lib/room.js; o e2e compara os resolvedores)
# ---------------------------------------------------------------------------


def is_object(value):
    return isinstance(value, dict)


def fail(context, message):
    raise PlanError(f"{context}: {message}")


def check_keys(raw, allowed, context):
    for key in raw:
        if key not in allowed:
            fail(context, f'campo desconhecido "{key}" (aceitos: {", ".join(sorted(allowed))})')


def field_string(value, context, default=None, max_length=200, pattern=None):
    if value is None:
        if default is None:
            fail(context, "é obrigatório")
        return default
    if not isinstance(value, str):
        fail(context, "deve ser texto")
    text = value.strip()
    if not text:
        fail(context, "não pode ser vazio")
    if len(text) > max_length:
        fail(context, f"deve ter no máximo {max_length} caracteres")
    if pattern is not None and not pattern.match(text):
        fail(context, f'formato inválido: "{text}"')
    return text


def field_id(value, context, default):
    return field_string(value, context, default, 64, None)


def field_optional_string(value, context, max_length=200):
    if value is None:
        return None
    return field_string(value, context, None, max_length)


def field_number(value, context, default=None, minimum=-math.inf, maximum=math.inf):
    if value is None:
        if default is None:
            fail(context, "é obrigatório")
        return default
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        fail(context, "deve ser um número finito")
    number_value = float(value)
    if not math.isfinite(number_value):
        fail(context, "deve ser um número finito")
    if number_value < minimum or number_value > maximum:
        fail(context, f"deve estar entre {minimum} e {maximum}")
    return number_value


def field_integer(value, context, default, minimum, maximum):
    result = field_number(value, context, default, minimum, maximum)
    if not float(result).is_integer():
        fail(context, "deve ser um inteiro")
    return int(result)


def field_boolean(value, context, default):
    if value is None:
        return default
    if not isinstance(value, bool):
        fail(context, "deve ser true ou false")
    return value


def field_vector3(value, context, default=None):
    if value is None:
        if default is None:
            fail(context, "é obrigatório")
        return list(default)
    if not isinstance(value, list) or len(value) != 3:
        fail(context, "deve ser [x, y, z] com números finitos")
    result = []
    for item in value:
        if isinstance(item, bool) or not isinstance(item, (int, float)) or not math.isfinite(float(item)):
            fail(context, "deve ser [x, y, z] com números finitos")
        result.append(float(item))
    return result


def srgb_to_linear(channel):
    if channel <= 0.04045:
        return channel / 12.92
    return ((channel + 0.055) / 1.055) ** 2.4


def field_color(value, context, default=None):
    if value is None:
        if default is None:
            fail(context, "é obrigatório")
        return list(default)
    if isinstance(value, str):
        text = value.strip()
        if len(text) != 7 or not text.startswith("#"):
            fail(context, 'cor hex deve ter o formato #rrggbb')
        try:
            integer = int(text[1:], 16)
        except ValueError:
            fail(context, 'cor hex deve ter o formato #rrggbb')
        return [
            srgb_to_linear(((integer >> 16) & 0xFF) / 255.0),
            srgb_to_linear(((integer >> 8) & 0xFF) / 255.0),
            srgb_to_linear((integer & 0xFF) / 255.0),
        ]
    if isinstance(value, list) and len(value) == 3:
        result = []
        for item in value:
            if isinstance(item, bool) or not isinstance(item, (int, float)) or not (0 <= item <= 1):
                fail(context, "cor deve ser \"#rrggbb\" (sRGB) ou [r,g,b] linear entre 0 e 1")
            result.append(float(item))
        return result
    fail(context, 'cor deve ser "#rrggbb" (sRGB) ou [r,g,b] linear entre 0 e 1')


def normalize_texture(raw, context):
    if not is_object(raw):
        fail(context, "deve ser um objeto")
    allowed = {"type", "scale", "detail", "roughness", "distortion", "color1", "color2", "path", "projection"}
    check_keys(raw, allowed, context)
    kind = field_string(raw.get("type"), f"{context}.type", None, 20).lower()
    if kind not in ("noise", "voronoi", "wave", "checker", "image"):
        fail(f"{context}.type", "use noise, voronoi, wave, checker ou image")
    texture = {
        "type": kind,
        "scale": field_number(raw.get("scale"), f"{context}.scale", 6 if kind == "noise" else 4, 0.001, 10000),
        "detail": field_number(raw.get("detail"), f"{context}.detail", 3, 0, 32),
        "roughness": field_number(raw.get("roughness"), f"{context}.roughness", 0.5, 0, 1),
        "distortion": field_number(raw.get("distortion"), f"{context}.distortion", 0, 0, 100),
        "color1": field_color(raw.get("color1"), f"{context}.color1", [0.02, 0.02, 0.02]),
        "color2": field_color(raw.get("color2"), f"{context}.color2", [0.8, 0.8, 0.8]),
        "projection": field_string(raw.get("projection"), f"{context}.projection", "flat", 10).lower(),
    }
    if texture["projection"] not in ("flat", "box"):
        fail(f"{context}.projection", 'use "flat" ou "box"')
    if kind == "image":
        texture["path"] = field_string(raw.get("path"), f"{context}.path", None, 500)
    return texture


def normalize_normal(raw, context):
    if raw is None:
        return None
    if isinstance(raw, str):
        return {"type": "image", "path": raw, "strength": 0.5, "scale": 20}
    if not is_object(raw):
        fail(context, "deve ser um caminho de textura ou um objeto {type, ...}")
    check_keys(raw, {"type", "strength", "scale", "path"}, context)
    kind = field_string(raw.get("type"), f"{context}.type", "bump", 10).lower()
    if kind not in ("bump", "image"):
        fail(f"{context}.type", 'use "bump" ou "image"')
    normal = {
        "type": kind,
        "strength": field_number(raw.get("strength"), f"{context}.strength", 0.5, 0, 4),
        "scale": field_number(raw.get("scale"), f"{context}.scale", 20, 0.001, 10000),
    }
    if kind == "image":
        normal["path"] = field_string(raw.get("path"), f"{context}.path", None, 500)
    return normal


def normalize_material(name, raw):
    context = f"materials.{name}"
    if not is_object(raw):
        fail(context, "deve ser um objeto")
    check_keys(raw, MATERIAL_KEYS, context)
    textures = raw.get("textures") or []
    if not isinstance(textures, list):
        fail(f"{context}.textures", "deve ser uma lista")
    if len(textures) > 8:
        fail(f"{context}.textures", "limite de 8 texturas por material")
    emission_raw = raw.get("emission") or {}
    if not is_object(emission_raw):
        fail(f"{context}.emission", "deve ser um objeto {color, strength}")
    check_keys(emission_raw, {"color", "strength"}, f"{context}.emission")
    return {
        "baseColor": field_color(raw.get("baseColor"), f"{context}.baseColor", [0.8, 0.8, 0.8]),
        "metallic": field_number(raw.get("metallic"), f"{context}.metallic", 0, 0, 1),
        "roughness": field_number(raw.get("roughness"), f"{context}.roughness", 0.5, 0, 1),
        "ior": field_number(raw.get("ior"), f"{context}.ior", 1.45, 1, 3),
        "transmission": field_number(raw.get("transmission"), f"{context}.transmission", 0, 0, 1),
        "subsurface": field_number(raw.get("subsurface"), f"{context}.subsurface", 0, 0, 1),
        "coat": field_number(raw.get("coat"), f"{context}.coat", 0, 0, 1),
        "sheen": field_number(raw.get("sheen"), f"{context}.sheen", 0, 0, 1),
        "anisotropy": field_number(raw.get("anisotropy"), f"{context}.anisotropy", 0, -1, 1),
        "emission": {
            "color": field_color(emission_raw.get("color"), f"{context}.emission.color", [0, 0, 0]),
            "strength": field_number(emission_raw.get("strength"), f"{context}.emission.strength", 0, 0, 1e6),
        },
        "normal": normalize_normal(raw.get("normal"), f"{context}.normal"),
        "textures": [normalize_texture(texture, f"{context}.textures[{index}]") for index, texture in enumerate(textures)],
    }


def normalize_materials(raw):
    if raw is None:
        return {}
    if not is_object(raw):
        fail("materials", "deve ser um objeto {nome: material}")
    if len(raw) > LIMITS["maxMaterials"]:
        fail("materials", f"limite de {LIMITS['maxMaterials']} materiais")
    result = {}
    for name, definition in raw.items():
        if not isinstance(name, str) or not name or len(name) > 64:
            fail("materials", f'nome de material inválido: "{name}"')
        result[name] = normalize_material(name, definition)
    return result


def normalize_interior(raw):
    if not is_object(raw):
        fail("room.interior", "deve ser um objeto {width, depth, height}")
    check_keys(raw, {"width", "depth", "height"}, "room.interior")
    return {
        "width": field_number(raw.get("width"), "room.interior.width", None, 1.5, 15),
        "depth": field_number(raw.get("depth"), "room.interior.depth", None, 1.5, 15),
        "height": field_number(raw.get("height"), "room.interior.height", None, 2, 6),
    }


def normalize_surface(raw, context, default_thickness):
    if not is_object(raw):
        fail(context, "deve ser um objeto {material, thickness}")
    check_keys(raw, {"material", "thickness"}, context)
    return {
        "material": field_string(raw.get("material"), f"{context}.material", None, 64),
        "thickness": field_number(raw.get("thickness"), f"{context}.thickness", default_thickness, 0.01, 0.5),
    }


def normalize_opening_style(raw):
    if raw is None:
        raw = {}
    if not is_object(raw):
        fail("room.openings", "deve ser um objeto")
    check_keys(raw, {"frame", "glass", "frameMaterial", "glassMaterial"}, "room.openings")
    frame_raw = raw.get("frame") or {}
    if not is_object(frame_raw):
        fail("room.openings.frame", "deve ser um objeto")
    check_keys(frame_raw, {"profile", "depth", "mullions", "transom", "material"}, "room.openings.frame")
    return {
        "frame": {
            "profile": field_number(frame_raw.get("profile"), "room.openings.frame.profile", DEFAULTS["frameProfile"], 0.005, 0.3),
            "depth": field_number(frame_raw.get("depth"), "room.openings.frame.depth", DEFAULTS["frameDepth"], 0.005, 0.6),
            "mullions": field_integer(frame_raw.get("mullions"), "room.openings.frame.mullions", 0, 0, 6),
            "transom": field_number(frame_raw.get("transom"), "room.openings.frame.transom", 0, 0, 3),
            "material": field_optional_string(frame_raw.get("material"), "room.openings.frame.material", 64),
        },
        "glass": field_boolean(raw.get("glass"), "room.openings.glass", True),
        "frameMaterial": field_string(raw.get("frameMaterial"), "room.openings.frameMaterial", None, 64),
        "glassMaterial": field_string(raw.get("glassMaterial"), "room.openings.glassMaterial", None, 64),
    }


def normalize_opening(raw, context, wall_length, room_height, style, default_id="abertura"):
    if not is_object(raw):
        fail(context, "deve ser um objeto")
    check_keys(raw, {"id", "type", "u", "bottom", "width", "height", "frame", "glass", "leaf"}, context)
    kind = field_string(raw.get("type"), f"{context}.type", "window", 10).lower()
    if kind not in ("window", "door"):
        fail(f"{context}.type", 'use "window" ou "door"')
    width = field_number(raw.get("width"), f"{context}.width", None, 0.3, min(6, wall_length))
    height = field_number(raw.get("height"), f"{context}.height", None, 0.3, room_height - 0.02)
    bottom = field_number(raw.get("bottom"), f"{context}.bottom", 0 if kind == "door" else 0.9, 0, room_height - 0.3)
    u = field_number(raw.get("u"), f"{context}.u", None, 0, max(0, wall_length - width))
    if u + width > wall_length + 1e-9:
        fail(f"{context}.u", f"abertura passa da parede (u={u} + width={width} > {wall_length})")
    if bottom + height > room_height - 0.01 + 1e-9:
        fail(f"{context}.bottom", f"abertura passa do teto (bottom={bottom} + height={height} > {room_height})")
    if kind == "door" and bottom > 0.01:
        fail(f"{context}.bottom", "porta precisa começar no piso (bottom = 0)")
    frame_raw = raw.get("frame") or {}
    if not is_object(frame_raw):
        fail(f"{context}.frame", "deve ser um objeto")
    check_keys(frame_raw, {"profile", "depth", "mullions", "transom", "material"}, f"{context}.frame")
    frame = {
        "profile": field_number(frame_raw.get("profile"), f"{context}.frame.profile", style["frame"]["profile"], 0.005, 0.3),
        "depth": field_number(frame_raw.get("depth"), f"{context}.frame.depth", style["frame"]["depth"], 0.005, 0.6),
        "mullions": field_integer(frame_raw.get("mullions"), f"{context}.frame.mullions", style["frame"]["mullions"], 0, 6),
        "transom": field_number(frame_raw.get("transom"), f"{context}.frame.transom", style["frame"]["transom"], 0, 3),
        "material": field_optional_string(frame_raw.get("material"), f"{context}.frame.material", 64),
    }
    frame_material = frame["material"] or style["frameMaterial"]
    glass = field_boolean(raw.get("glass"), f"{context}.glass", style["glass"] if kind == "window" else False)
    if glass and not style["glassMaterial"]:
        fail(f"{context}.glass", "vidro ligado mas room.openings.glassMaterial não foi definido")
    if not frame_material:
        fail(f"{context}.frame.material", "nenhum material de esquadria definido (room.openings.frameMaterial)")
    return {
        "id": field_id(raw.get("id"), f"{context}.id", default_id),
        "type": kind,
        "u": u,
        "bottom": bottom,
        "width": width,
        "height": height,
        "frame": frame,
        "frameMaterial": frame_material,
        "glass": glass,
        "leaf": field_boolean(raw.get("leaf"), f"{context}.leaf", False),
        "glassMaterial": style["glassMaterial"],
    }


def normalize_room(raw, materials):
    if not is_object(raw):
        fail("room", "deve ser um objeto")
    check_keys(raw, {"interior", "wallThickness", "floor", "ceiling", "walls", "openings"}, "room")
    interior = normalize_interior(raw.get("interior"))
    wall_thickness = field_number(raw.get("wallThickness"), "room.wallThickness", DEFAULTS["wallThickness"], 0.05, 0.5)
    style = normalize_opening_style(raw.get("openings"))
    floor = normalize_surface(raw.get("floor"), "room.floor", DEFAULTS["floorThickness"])
    ceiling = normalize_surface(raw.get("ceiling"), "room.ceiling", DEFAULTS["ceilingThickness"])
    for label, surface in (("floor", floor), ("ceiling", ceiling)):
        if surface["material"] not in materials:
            fail(f"room.{label}.material", f'material "{surface["material"]}" não existe em materials')

    walls_raw = raw.get("walls")
    if not isinstance(walls_raw, list) or len(walls_raw) != 4:
        fail("room.walls", "precisa das 4 paredes (north, south, east, west)")
    walls = []
    seen = set()
    for index, wall_raw in enumerate(walls_raw):
        context = f"room.walls[{index}]"
        if not is_object(wall_raw):
            fail(context, "deve ser um objeto {side, material, openings}")
        check_keys(wall_raw, {"side", "material", "openings"}, context)
        side = field_string(wall_raw.get("side"), f"{context}.side", None, 10).lower()
        if side not in SIDES:
            fail(f"{context}.side", f"use um de: {', '.join(SIDES)}")
        if side in seen:
            fail(f"{context}.side", f'parede "{side}" duplicada')
        seen.add(side)
        material = field_string(wall_raw.get("material"), f"{context}.material", None, 64)
        if material not in materials:
            fail(f"{context}.material", f'material "{material}" não existe em materials')
        wall_length = interior["width"] if side in ("north", "south") else interior["depth"]
        openings_raw = wall_raw.get("openings") or []
        if not isinstance(openings_raw, list):
            fail(f"{context}.openings", "deve ser uma lista")
        if len(openings_raw) > 8:
            fail(f"{context}.openings", "limite de 8 aberturas por parede")
        openings = [normalize_opening(opening, f"{context}.openings[{i}]", wall_length, interior["height"], style, f"{side}-abertura-{i + 1}") for i, opening in enumerate(openings_raw)]
        walls.append({"side": side, "material": material, "length": wall_length, "openings": openings})
    for side in SIDES:
        if side not in seen:
            fail("room.walls", f'falta a parede "{side}"')
    all_openings = [(wall["side"], opening) for wall in walls for opening in wall["openings"]]
    if len(all_openings) > LIMITS["maxOpenings"]:
        fail("room.walls", f"limite de {LIMITS['maxOpenings']} aberturas")
    for side, opening in all_openings:
        if opening["type"] == "window" and not opening["glass"]:
            fail(f"room.walls.{side}", f'janela "{opening["id"]}" precisa de vidro (glass) nesta versão')
        if opening["frameMaterial"] not in materials:
            fail("room.openings.frameMaterial", f'material "{opening["frameMaterial"]}" não existe em materials')
        if opening["glass"] and opening["glassMaterial"] not in materials:
            fail("room.openings.glassMaterial", f'material "{opening["glassMaterial"]}" não existe em materials')
    return {
        "interior": interior,
        "wallThickness": wall_thickness,
        "floor": floor,
        "ceiling": ceiling,
        "walls": walls,
        "openings": all_openings,
        "style": style,
    }


def normalize_furniture(raw, materials):
    if raw is None:
        return []
    if not isinstance(raw, list):
        fail("furniture", "deve ser uma lista")
    if len(raw) > LIMITS["maxFurniture"]:
        fail("furniture", f"limite de {LIMITS['maxFurniture']} peças")
    result = []
    seen = set()
    for index, item in enumerate(raw):
        context = f"furniture[{index}]"
        if not is_object(item):
            fail(context, "deve ser um objeto")
        check_keys(item, {"id", "name", "shape", "size", "position", "rotation", "material", "bevel", "smooth", "support", "collisionGroup", "detail"}, context)
        piece_id = field_id(item.get("id"), f"{context}.id", f"peca-{index + 1}")
        if piece_id in seen:
            fail(f"{context}.id", f'id duplicado "{piece_id}"')
        seen.add(piece_id)
        shape = field_string(item.get("shape"), f"{context}.shape", "box", 10).lower()
        if shape not in ("box", "roundbox", "cylinder"):
            fail(f"{context}.shape", "use box, roundbox ou cylinder")
        material = field_string(item.get("material"), f"{context}.material", None, 64)
        if material not in materials:
            fail(f"{context}.material", f'material "{material}" não existe em materials')
        size = field_vector3(item.get("size"), f"{context}.size")
        if any(value < 0.01 or value > 12 for value in size):
            fail(f"{context}.size", "cada eixo deve estar entre 0.01 e 12 m")
        result.append({
            "id": piece_id,
            "name": field_string(item.get("name"), f"{context}.name", piece_id, 120),
            "shape": shape,
            "size": size,
            "position": field_vector3(item.get("position"), f"{context}.position"),
            "rotation": field_vector3(item.get("rotation"), f"{context}.rotation", [0, 0, 0]),
            "material": material,
            "bevel": field_number(item.get("bevel"), f"{context}.bevel", 0.03 if shape == "roundbox" else 0, 0, 0.25),
            "smooth": field_boolean(item.get("smooth"), f"{context}.smooth", shape != "box"),
            "support": field_string(item.get("support"), f"{context}.support", "floor", 12).lower(),
            "collisionGroup": field_optional_string(item.get("collisionGroup"), f"{context}.collisionGroup", 64) or piece_id.split("-")[0],
            "detail": field_boolean(item.get("detail"), f"{context}.detail", False),
        })
    for item in result:
        if item["support"] not in ("floor", "furniture", "wall", "ceiling"):
            fail(f'furniture[{item["id"]}].support', 'use "floor", "furniture", "wall" ou "ceiling"')
    return result


def normalize_assets(raw, materials):
    if raw is None:
        return []
    if not isinstance(raw, list):
        fail("assets", "deve ser uma lista")
    if len(raw) > LIMITS["maxAssets"]:
        fail("assets", f"limite de {LIMITS['maxAssets']} assets")
    result = []
    seen = set()
    for index, item in enumerate(raw):
        context = f"assets[{index}]"
        if not is_object(item):
            fail(context, "deve ser um objeto")
        check_keys(item, {"id", "assetId", "position", "rotation", "scale", "fitHeight", "anchor", "snapToFloor", "materialOverride", "visible", "support"}, context)
        placement_id = field_id(item.get("id"), f"{context}.id", f"asset-{index + 1}")
        if placement_id in seen:
            fail(f"{context}.id", f'id duplicado "{placement_id}"')
        seen.add(placement_id)
        anchor = field_string(item.get("anchor"), f"{context}.anchor", "bottom", 10).lower()
        if anchor not in ("bottom", "origin"):
            fail(f"{context}.anchor", 'use "bottom" ou "origin"')
        material_override = field_optional_string(item.get("materialOverride"), f"{context}.materialOverride", 64)
        if material_override and material_override not in materials:
            fail(f"{context}.materialOverride", f'material "{material_override}" não existe em materials')
        result.append({
            "id": placement_id,
            "assetId": field_string(item.get("assetId"), f"{context}.assetId", None, 80),
            "position": field_vector3(item.get("position"), f"{context}.position"),
            "rotation": field_vector3(item.get("rotation"), f"{context}.rotation", [0, 0, 0]),
            "scale": field_number(item.get("scale"), f"{context}.scale", 1, 0.002, 50),
            "fitHeight": None if item.get("fitHeight") is None else field_number(item.get("fitHeight"), f"{context}.fitHeight", None, 0.01, 12),
            "anchor": anchor,
            "snapToFloor": field_boolean(item.get("snapToFloor"), f"{context}.snapToFloor", True),
            "materialOverride": material_override,
            "visible": field_boolean(item.get("visible"), f"{context}.visible", True),
            "support": field_string(item.get("support"), f"{context}.support", "floor", 12).lower(),
        })
    for item in result:
        if item["support"] not in ("floor", "furniture", "wall", "ceiling"):
            fail(f'assets[{item["id"]}].support', 'use "floor", "furniture", "wall" ou "ceiling"')
    return result


def normalize_fixture(raw, context):
    if not is_object(raw):
        fail(context, "deve ser um objeto")
    check_keys(raw, {"id", "type", "position", "size", "watts", "color", "target", "enabled", "spotSize", "spotBlend"}, context)
    kind = field_string(raw.get("type"), f"{context}.type", None, 10).upper()
    if kind not in ("AREA", "POINT", "SPOT"):
        fail(f"{context}.type", "use AREA, POINT ou SPOT (sol e céu vêm do preset)")
    return {
        "id": field_id(raw.get("id"), f"{context}.id", f"luz-{context}"),
        "type": kind,
        "position": field_vector3(raw.get("position"), f"{context}.position"),
        "size": field_number(raw.get("size"), f"{context}.size", 0.4, 0.001, 25),
        "watts": field_number(raw.get("watts"), f"{context}.watts", None, 0, 10000),
        "color": field_color(raw.get("color"), f"{context}.color", [1.0, 0.86, 0.72]),
        "target": None if raw.get("target") is None else field_vector3(raw.get("target"), f"{context}.target"),
        "enabled": field_boolean(raw.get("enabled"), f"{context}.enabled", True),
        "spotSize": field_number(raw.get("spotSize"), f"{context}.spotSize", 60, 1, 180),
        "spotBlend": field_number(raw.get("spotBlend"), f"{context}.spotBlend", 0.4, 0, 1),
    }


def normalize_lighting_overrides(raw, context):
    if raw is None:
        return {"sun": None, "world": None, "windowFill": None, "exposure": None}
    if not is_object(raw):
        fail(context, "deve ser um objeto")
    check_keys(raw, {"sun", "world", "windowFill", "exposure"}, context)
    result = {"sun": None, "world": None, "windowFill": None, "exposure": None}
    if raw.get("sun") is not None:
        sun_raw = raw["sun"]
        if not is_object(sun_raw):
            fail(f"{context}.sun", "deve ser um objeto")
        check_keys(sun_raw, {"enabled", "strength", "color", "angle", "azimuth", "elevation"}, f"{context}.sun")
        partial = {}
        for key, value in sun_raw.items():
            if key == "enabled":
                partial["enabled"] = field_boolean(value, f"{context}.sun.enabled", True)
            elif key == "strength":
                partial["strength"] = field_number(value, f"{context}.sun.strength", 4, 0, 1000)
            elif key == "color":
                partial["color"] = field_color(value, f"{context}.sun.color", [1, 0.9, 0.8])
            elif key == "angle":
                partial["angle"] = field_number(value, f"{context}.sun.angle", 0.8, 0, 180)
            elif key == "azimuth":
                partial["azimuth"] = field_number(value, f"{context}.sun.azimuth", 150, 0, 360)
            elif key == "elevation":
                partial["elevation"] = field_number(value, f"{context}.sun.elevation", 30, -10, 90)
        result["sun"] = partial
    if raw.get("world") is not None:
        world_raw = raw["world"]
        if not is_object(world_raw):
            fail(f"{context}.world", "deve ser um objeto")
        check_keys(world_raw, {"kind", "color", "strength"}, f"{context}.world")
        partial = {}
        if "kind" in world_raw:
            kind = field_string(world_raw["kind"], f"{context}.world.kind", "hdri", 10).lower()
            if kind not in ("hdri", "color"):
                fail(f"{context}.world.kind", 'use "hdri" ou "color"')
            partial["kind"] = kind
        if "color" in world_raw:
            partial["color"] = field_color(world_raw["color"], f"{context}.world.color", [0.03, 0.03, 0.04])
        if "strength" in world_raw:
            partial["strength"] = field_number(world_raw["strength"], f"{context}.world.strength", 1, 0, 1000)
        result["world"] = partial
    if raw.get("windowFill") is not None:
        fill_raw = raw["windowFill"]
        if not is_object(fill_raw):
            fail(f"{context}.windowFill", "deve ser um objeto")
        check_keys(fill_raw, {"enabled", "energy", "size", "color"}, f"{context}.windowFill")
        partial = {}
        if "enabled" in fill_raw:
            partial["enabled"] = field_boolean(fill_raw["enabled"], f"{context}.windowFill.enabled", True)
        if "energy" in fill_raw:
            partial["energy"] = field_number(fill_raw["energy"], f"{context}.windowFill.energy", 900, 0, 100000)
        if "size" in fill_raw:
            partial["size"] = field_number(fill_raw["size"], f"{context}.windowFill.size", 2.8, 0.05, 20)
        if "color" in fill_raw:
            partial["color"] = field_color(fill_raw["color"], f"{context}.windowFill.color", [0.85, 0.92, 1])
        result["windowFill"] = partial
    if raw.get("exposure") is not None:
        result["exposure"] = field_number(raw["exposure"], f"{context}.exposure", 0, -8, 8)
    return result


def normalize_lighting(raw):
    if raw is None:
        raw = {}
    if not is_object(raw):
        fail("lighting", "deve ser um objeto")
    check_keys(raw, {"preset", "hdri", "environmentRotation", "overrides", "overridesByPreset", "interiorFixtures"}, "lighting")
    preset_raw = field_string(raw.get("preset"), "lighting.preset", "day", 20).lower()
    preset = PRESET_ALIASES.get(preset_raw)
    if preset is None:
        fail("lighting.preset", f"use um de: {', '.join(PRESET_NAMES)} (ou dia/fim-de-tarde/noite)")
    hdri_raw = raw.get("hdri")
    if hdri_raw is None:
        hdri = None
    elif isinstance(hdri_raw, str):
        hdri = field_string(hdri_raw, "lighting.hdri", None, 80)
    elif is_object(hdri_raw):
        hdri = {}
        for key, value in hdri_raw.items():
            if key not in PRESET_NAMES:
                fail("lighting.hdri", f'preset desconhecido em hdri: "{key}"')
            hdri[key] = field_string(value, f"lighting.hdri.{key}", None, 80)
    else:
        fail("lighting.hdri", "deve ser um id ou um objeto {preset: id}")
    overrides = normalize_lighting_overrides(raw.get("overrides"), "lighting.overrides")
    overrides_by_preset = {}
    by_preset_raw = raw.get("overridesByPreset")
    if by_preset_raw is not None:
        if not is_object(by_preset_raw):
            fail("lighting.overridesByPreset", "deve ser um objeto {preset: overrides}")
        for key, value in by_preset_raw.items():
            if key not in PRESET_NAMES:
                fail("lighting.overridesByPreset", f'preset desconhecido "{key}"')
            overrides_by_preset[key] = normalize_lighting_overrides(value, f"lighting.overridesByPreset.{key}")
    fixtures_raw = raw.get("interiorFixtures") or []
    if not isinstance(fixtures_raw, list):
        fail("lighting.interiorFixtures", "deve ser uma lista")
    if len(fixtures_raw) > LIMITS["maxFixtures"]:
        fail("lighting.interiorFixtures", f"limite de {LIMITS['maxFixtures']} luminárias")
    fixtures = []
    seen = set()
    for index, fixture_raw in enumerate(fixtures_raw):
        fixture = normalize_fixture(fixture_raw, f"lighting.interiorFixtures[{index}]")
        if fixture["id"] in seen:
            fail(f"lighting.interiorFixtures[{index}].id", f'id duplicado "{fixture["id"]}"')
        seen.add(fixture["id"])
        fixtures.append(fixture)
    return {
        "preset": preset,
        "hdri": hdri,
        "environmentRotation": field_number(raw.get("environmentRotation"), "lighting.environmentRotation", 0, -360, 360),
        "overrides": overrides,
        "overridesByPreset": overrides_by_preset,
        "interiorFixtures": fixtures,
    }


def normalize_exterior(raw, materials):
    if raw is None:
        return None
    if not is_object(raw):
        fail("exterior", "deve ser um objeto")
    check_keys(raw, {"balcony", "backdrop"}, "exterior")
    balcony_raw = raw.get("balcony")
    backdrop_raw = raw.get("backdrop")
    balcony = None
    if balcony_raw is not None:
        if not is_object(balcony_raw):
            fail("exterior.balcony", "deve ser um objeto")
        check_keys(balcony_raw, {"enabled", "depth", "railingHeight", "bars", "material"}, "exterior.balcony")
        material = field_string(balcony_raw.get("material"), "exterior.balcony.material", None, 64)
        if material not in materials:
            fail("exterior.balcony.material", f'material "{material}" não existe em materials')
        balcony = {
            "enabled": field_boolean(balcony_raw.get("enabled"), "exterior.balcony.enabled", True),
            "depth": field_number(balcony_raw.get("depth"), "exterior.balcony.depth", 1.1, 0.2, 5),
            "railingHeight": field_number(balcony_raw.get("railingHeight"), "exterior.balcony.railingHeight", 1.05, 0.2, 2),
            "bars": field_integer(balcony_raw.get("bars"), "exterior.balcony.bars", 11, 0, 60),
            "material": material,
        }
    backdrop = None
    if backdrop_raw is not None:
        if not is_object(backdrop_raw):
            fail("exterior.backdrop", "deve ser um objeto")
        check_keys(backdrop_raw, {"enabled", "facade", "hedge"}, "exterior.backdrop")
        facade_raw = backdrop_raw.get("facade")
        hedge_raw = backdrop_raw.get("hedge")
        if not is_object(facade_raw):
            fail("exterior.backdrop.facade", "deve ser um objeto {material, distance, width, height}")
        check_keys(facade_raw, {"material", "distance", "width", "height"}, "exterior.backdrop.facade")
        if not is_object(hedge_raw):
            fail("exterior.backdrop.hedge", "deve ser um objeto {material, width, height, depth, offset}")
        check_keys(hedge_raw, {"material", "width", "height", "depth", "offset"}, "exterior.backdrop.hedge")
        facade_material = field_string(facade_raw.get("material"), "exterior.backdrop.facade.material", None, 64)
        hedge_material = field_string(hedge_raw.get("material"), "exterior.backdrop.hedge.material", None, 64)
        if facade_material not in materials:
            fail("exterior.backdrop.facade.material", f'material "{facade_material}" não existe em materials')
        if hedge_material not in materials:
            fail("exterior.backdrop.hedge.material", f'material "{hedge_material}" não existe em materials')
        backdrop = {
            "enabled": field_boolean(backdrop_raw.get("enabled"), "exterior.backdrop.enabled", True),
            "facade": {
                "material": facade_material,
                "distance": field_number(facade_raw.get("distance"), "exterior.backdrop.facade.distance", 6.5, 1, 40),
                "width": field_number(facade_raw.get("width"), "exterior.backdrop.facade.width", 18, 2, 80),
                "height": field_number(facade_raw.get("height"), "exterior.backdrop.facade.height", 9, 1, 40),
            },
            "hedge": {
                "material": hedge_material,
                "width": field_number(hedge_raw.get("width"), "exterior.backdrop.hedge.width", 3.6, 0.2, 20),
                "height": field_number(hedge_raw.get("height"), "exterior.backdrop.hedge.height", 1.0, 0.1, 4),
                "depth": field_number(hedge_raw.get("depth"), "exterior.backdrop.hedge.depth", 0.7, 0.1, 5),
                "offset": field_number(hedge_raw.get("offset"), "exterior.backdrop.hedge.offset", 0.45, 0, 5),
            },
        }
    if balcony is None and backdrop is None:
        return None
    return {"balcony": balcony, "backdrop": backdrop}


def normalize_camera(raw):
    raw = raw or {}
    if not is_object(raw):
        fail("camera", "deve ser um objeto")
    check_keys(raw, {"location", "target", "rotation", "lens", "sensorWidth", "fstop", "focus", "focusDistance", "motionBlur"}, "camera")
    rotation = None if raw.get("rotation") is None else field_vector3(raw["rotation"], "camera.rotation")
    target = None if raw.get("target") is None else field_vector3(raw["target"], "camera.target")
    if rotation is not None and target is not None:
        fail("camera", 'use "target" ou "rotation", não os dois')
    if rotation is None and target is None:
        target = [0.0, 0.0, 0.9]
    focus = field_string(raw.get("focus"), "camera.focus", "target", 10).lower()
    if focus not in ("target", "none"):
        fail("camera.focus", 'use "target" ou "none"')
    return {
        "location": field_vector3(raw.get("location"), "camera.location", [4.5, -4.5, 2.8]),
        "target": target,
        "rotation": rotation,
        "lens": field_number(raw.get("lens"), "camera.lens", 50, 8, 300),
        "sensorWidth": field_number(raw.get("sensorWidth"), "camera.sensorWidth", 36, 1, 100),
        "fstop": field_number(raw.get("fstop"), "camera.fstop", 4, 0.7, 64),
        "focus": focus,
        "focusDistance": None if raw.get("focusDistance") is None else field_number(raw.get("focusDistance"), "camera.focusDistance", None, 0.001, 1000),
        "motionBlur": field_boolean(raw.get("motionBlur"), "camera.motionBlur", False),
    }


def normalize_render(raw):
    raw = raw or {}
    if not is_object(raw):
        fail("render", "deve ser um objeto")
    check_keys(raw, {"engine", "samples", "resolution", "preview", "render", "colorManagement", "output"}, "render")
    resolution = raw.get("resolution") or [1280, 854]
    if not isinstance(resolution, list) or len(resolution) != 2:
        fail("render.resolution", "deve ser [largura, altura]")
    width = field_integer(resolution[0], "render.resolution[0]", None, 64, 8192)
    height = field_integer(resolution[1], "render.resolution[1]", None, 64, 8192)
    if width * height > 50_000_000:
        fail("render.resolution", "máximo de 50 megapixels")
    preview = raw.get("preview") or {}
    render = raw.get("render") or {}
    color_management = raw.get("colorManagement") or {}
    output = raw.get("output") or {}
    if not all(is_object(item) for item in (preview, render, color_management, output)):
        fail("render", "preview/render/colorManagement/output devem ser objetos")
    return {
        "engine": field_string(raw.get("engine"), "render.engine", "CYCLES", 30).upper(),
        "samples": field_integer(raw.get("samples"), "render.samples", 256, 1, 100000),
        "resolution": [width, height],
        "preview": {
            "maxSize": field_integer(preview.get("maxSize"), "render.preview.maxSize", 640, 64, 4096),
            "samples": field_integer(preview.get("samples"), "render.preview.samples", 64, 1, 100000),
        },
        "render": {
            "device": field_string(render.get("device"), "render.render.device", "GPU", 10).upper(),
            "adaptive": field_boolean(render.get("adaptive"), "render.render.adaptive", True),
            "denoise": field_boolean(render.get("denoise"), "render.render.denoise", True),
            "maxBounces": field_integer(render.get("maxBounces"), "render.render.maxBounces", 10, 1, 64),
        },
        "colorManagement": {
            "viewTransform": field_string(color_management.get("viewTransform"), "render.colorManagement.viewTransform", "AgX", 30),
            "look": field_string(color_management.get("look"), "render.colorManagement.look", "AgX - Medium High Contrast", 60),
            "exposure": field_number(color_management.get("exposure"), "render.colorManagement.exposure", 0, -16, 16),
        },
        "output": {
            "format": field_string(output.get("format"), "render.output.format", "PNG", 6).upper(),
            "transparent": field_boolean(output.get("transparent"), "render.output.transparent", False),
            "colorDepth": field_string(output.get("colorDepth"), "render.output.colorDepth", "16", 4),
        },
    }


def normalize_evaluation(raw):
    if raw is None:
        return None
    if not is_object(raw):
        fail("evaluation", "deve ser um objeto")
    check_keys(raw, {"reference", "referenceMask", "requireMasks", "regions", "thresholds", "histogramBins", "maxEvalSize", "notes"}, "evaluation")
    regions_raw = raw.get("regions") or []
    if not isinstance(regions_raw, list):
        fail("evaluation.regions", "deve ser uma lista")
    regions = []
    seen = set()
    for index, region in enumerate(regions_raw):
        context = f"evaluation.regions[{index}]"
        if not is_object(region):
            fail(context, "deve ser um objeto")
        check_keys(region, {"id", "label", "rect"}, context)
        region_id = field_id(region.get("id"), f"{context}.id", f"regiao-{index + 1}")
        if region_id in seen:
            fail(f"{context}.id", f'id duplicado "{region_id}"')
        seen.add(region_id)
        rect = region.get("rect")
        if not isinstance(rect, list) or len(rect) != 4:
            fail(f"{context}.rect", "deve ser [x, y, largura, altura] normalizado")
        values = [field_number(item, f"{context}.rect[{i}]", None, 0, 1) for i, item in enumerate(rect)]
        x, y, w, h = values
        if w <= 0 or h <= 0 or x + w > 1.0001 or y + h > 1.0001:
            fail(f"{context}.rect", "retângulo precisa caber em 0..1")
        regions.append({"id": region_id, "label": field_string(region.get("label"), f"{context}.label", region_id, 80), "rect": values})
    thresholds_raw = raw.get("thresholds")
    thresholds = None
    if thresholds_raw is not None:
        if not is_object(thresholds_raw):
            fail("evaluation.thresholds", "deve ser um objeto")
        check_keys(thresholds_raw, {"ssimMin", "deltaE00Max", "deltaE00RegionMax", "histogramMax", "iouMin"}, "evaluation.thresholds")
        thresholds = {
            "ssimMin": field_number(thresholds_raw.get("ssimMin"), "evaluation.thresholds.ssimMin", 0.5, -1, 1),
            "deltaE00Max": field_number(thresholds_raw.get("deltaE00Max"), "evaluation.thresholds.deltaE00Max", 20, 0, 100),
            "deltaE00RegionMax": field_number(thresholds_raw.get("deltaE00RegionMax"), "evaluation.thresholds.deltaE00RegionMax", 28, 0, 100),
            "histogramMax": field_number(thresholds_raw.get("histogramMax"), "evaluation.thresholds.histogramMax", 0.35, 0, 1),
            "iouMin": field_number(thresholds_raw.get("iouMin"), "evaluation.thresholds.iouMin", 0.6, 0, 1),
        }
    return {
        "reference": field_optional_string(raw.get("reference"), "evaluation.reference", 500),
        "referenceMask": field_optional_string(raw.get("referenceMask"), "evaluation.referenceMask", 500),
        "requireMasks": field_boolean(raw.get("requireMasks"), "evaluation.requireMasks", False),
        "regions": regions,
        "thresholds": thresholds,
        "histogramBins": field_integer(raw.get("histogramBins"), "evaluation.histogramBins", 16, 4, 256),
        "maxEvalSize": field_integer(raw.get("maxEvalSize"), "evaluation.maxEvalSize", 512, 64, 4096),
        "notes": field_optional_string(raw.get("notes"), "evaluation.notes", 2000),
    }


def normalize_reference(raw):
    if raw is None:
        return None
    if not is_object(raw):
        fail("reference", "deve ser um objeto")
    check_keys(raw, {"image", "measurements", "inventory", "fullyVisible"}, "reference")
    measurements_raw = raw.get("measurements")
    if not is_object(measurements_raw):
        fail("reference.measurements", "deve ser um objeto")
    check_keys(measurements_raw, {"windowRect", "horizonY", "cameraHeight", "sofaRect", "tableRect", "notes"}, "reference.measurements")
    window_rect = measurements_raw.get("windowRect")
    if not isinstance(window_rect, list) or len(window_rect) != 4:
        fail("reference.measurements.windowRect", "deve ser [x, y, largura, altura] normalizado")
    window_rect = [field_number(item, "reference.measurements.windowRect[%d]" % i, None, 0, 1) for i, item in enumerate(window_rect)]
    x, y, w, h = window_rect
    if w <= 0 or h <= 0 or x + w > 1.0001 or y + h > 1.0001:
        fail("reference.measurements.windowRect", "retângulo precisa caber em 0..1")
    def optional_rect(value, context):
        if value is None:
            return None
        if not isinstance(value, list) or len(value) != 4:
            fail(context, "deve ser [x, y, largura, altura] normalizado")
        return [field_number(item, f"{context}[{i}]", None, 0, 1) for i, item in enumerate(value)]
    def string_list(value, context):
        if value is None:
            return []
        if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
            fail(context, "deve ser uma lista de ids")
        return list(value)
    return {
        "image": field_optional_string(raw.get("image"), "reference.image", 500),
        "measurements": {
            "windowRect": window_rect,
            "horizonY": field_number(measurements_raw.get("horizonY"), "reference.measurements.horizonY", 0.5, 0, 1),
            "cameraHeight": field_number(measurements_raw.get("cameraHeight"), "reference.measurements.cameraHeight", 1.2, 0.3, 3),
            "sofaRect": optional_rect(measurements_raw.get("sofaRect"), "reference.measurements.sofaRect"),
            "tableRect": optional_rect(measurements_raw.get("tableRect"), "reference.measurements.tableRect"),
            "notes": field_optional_string(measurements_raw.get("notes"), "reference.measurements.notes", 1000),
        },
        "inventory": string_list(raw.get("inventory"), "reference.inventory"),
        "fullyVisible": string_list(raw.get("fullyVisible"), "reference.fullyVisible"),
    }


def validate_plan(raw):
    if not is_object(raw):
        fail("room plan", "deve ser um objeto JSON")
    check_keys(raw, {"schemaVersion", "name", "description", "room", "exterior", "materials", "furniture", "assets", "lighting", "camera", "render", "evaluation", "reference"}, "room plan")
    if raw.get("schemaVersion") is not None and raw.get("schemaVersion") != SCHEMA_VERSION:
        fail("schemaVersion", f"apenas {SCHEMA_VERSION} é aceito; recebi {raw.get('schemaVersion')}")
    materials = normalize_materials(raw.get("materials"))
    return {
        "schemaVersion": SCHEMA_VERSION,
        "name": field_string(raw.get("name"), "name", "Sala sem nome", 120),
        "description": field_optional_string(raw.get("description"), "description", 2000),
        "room": normalize_room(raw.get("room"), materials),
        "exterior": normalize_exterior(raw.get("exterior"), materials),
        "materials": materials,
        "furniture": normalize_furniture(raw.get("furniture"), materials),
        "assets": normalize_assets(raw.get("assets"), materials),
        "lighting": normalize_lighting(raw.get("lighting")),
        "camera": normalize_camera(raw.get("camera")),
        "render": normalize_render(raw.get("render")),
        "evaluation": normalize_evaluation(raw.get("evaluation")),
        "reference": normalize_reference(raw.get("reference")),
    }


# ---------------------------------------------------------------------------
# Presets e biblioteca de assets
# ---------------------------------------------------------------------------


def load_json(path, label):
    if not os.path.isfile(path):
        raise PlanError(f"{label} não encontrado: {path}")
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError) as error:
        raise PlanError(f"{label} inválido: {path} ({error})") from error


def load_presets(path):
    raw = load_json(path, "light-rig-presets.json")
    if not is_object(raw) or raw.get("schemaVersion") != 1:
        raise PlanError("light-rig-presets.json: schemaVersion deve ser 1")
    if not is_object(raw.get("presets")):
        raise PlanError("light-rig-presets.json: falta o objeto presets")
    presets = {}
    for name in PRESET_NAMES:
        preset = raw["presets"].get(name)
        if not is_object(preset):
            raise PlanError(f'light-rig-presets.json: falta o preset "{name}"')
        sun = preset.get("sun")
        world = preset.get("world") or {}
        fill = preset.get("windowFill") or {}
        if not is_object(sun):
            raise PlanError(f'light-rig-presets.json: preset "{name}" sem sun')
        presets[name] = {
            "label": field_string(preset.get("label"), f"light-rig-presets.{name}.label", name, 80),
            "exposure": field_number(preset.get("exposure"), f"light-rig-presets.{name}.exposure", 0, -8, 8),
            "sun": {
                "enabled": field_boolean(sun.get("enabled"), f"light-rig-presets.{name}.sun.enabled", True),
                "strength": field_number(sun.get("strength"), f"light-rig-presets.{name}.sun.strength", 4, 0, 1000),
                "color": field_color(sun.get("color"), f"light-rig-presets.{name}.sun.color", [1, 0.9, 0.8]),
                "angle": field_number(sun.get("angle"), f"light-rig-presets.{name}.sun.angle", 0.8, 0, 180),
                "azimuth": field_number(sun.get("azimuth"), f"light-rig-presets.{name}.sun.azimuth", 150, 0, 360),
                "elevation": field_number(sun.get("elevation"), f"light-rig-presets.{name}.sun.elevation", 30, -10, 90),
            },
            "world": {
                "kind": field_string(world.get("kind"), f"light-rig-presets.{name}.world.kind", "hdri", 10).lower(),
                "color": field_color(world.get("color"), f"light-rig-presets.{name}.world.color", [0.03, 0.03, 0.04]),
                "strength": field_number(world.get("strength"), f"light-rig-presets.{name}.world.strength", 1, 0, 1000),
            },
            "windowFill": {
                "enabled": field_boolean(fill.get("enabled"), f"light-rig-presets.{name}.windowFill.enabled", True),
                "energy": field_number(fill.get("energy"), f"light-rig-presets.{name}.windowFill.energy", 900, 0, 100000),
                "size": field_number(fill.get("size"), f"light-rig-presets.{name}.windowFill.size", 2.8, 0.05, 20),
                "color": field_color(fill.get("color"), f"light-rig-presets.{name}.windowFill.color", [0.85, 0.92, 1]),
            },
            "interiorMultiplier": field_number(preset.get("interiorMultiplier"), f"light-rig-presets.{name}.interiorMultiplier", 0, 0, 2),
        }
    for name in raw["presets"]:
        if name not in PRESET_NAMES:
            raise PlanError(f'light-rig-presets.json: preset desconhecido "{name}"')
    return presets


def normalize_asset_bbox(raw, context):
    if raw is None:
        return None
    if not is_object(raw):
        fail(context, "deve ser {min:[x,y,z], max:[x,y,z]}")
    low = raw.get("min")
    high = raw.get("max")
    if not isinstance(low, list) or len(low) != 3 or not isinstance(high, list) or len(high) != 3:
        fail(context, "deve ser {min:[x,y,z], max:[x,y,z]}")
    values = [field_number(item, f"{context}.min[{i}]", None) for i, item in enumerate(low)]
    values += [field_number(item, f"{context}.max[{i}]", None) for i, item in enumerate(high)]
    return {"min": values[:3], "max": values[3:]}


def load_library(path):
    raw = load_json(path, "assets-library.json")
    if not is_object(raw) or raw.get("schemaVersion") != 1:
        raise PlanError("assets-library.json: schemaVersion deve ser 1")
    assets_dir = field_string(raw.get("assetsDir"), "assets-library.assetsDir", "assets", 120)
    if ".." in assets_dir:
        raise PlanError('assets-library.assetsDir: não pode conter ".."')
    if not is_object(raw.get("assets")):
        raise PlanError("assets-library.json: falta o objeto assets")
    assets = {}
    for asset_id, entry in raw["assets"].items():
        if not is_object(entry):
            raise PlanError(f"assets-library.assets.{asset_id}: deve ser um objeto")
        kind = field_string(entry.get("kind"), f"assets-library.assets.{asset_id}.kind", None, 10)
        if kind not in ("model", "hdri"):
            raise PlanError(f'assets-library.assets.{asset_id}.kind: use "model" ou "hdri"')
        source = entry.get("source") or {}
        if not is_object(source):
            raise PlanError(f"assets-library.assets.{asset_id}.source: deve ser um objeto")
        license_name = field_string(source.get("license"), f"assets-library.assets.{asset_id}.source.license", None, 40)
        if license_name not in LICENSES:
            raise PlanError(f'assets-library.assets.{asset_id}.source.license: licença "{license_name}" não reconhecida')
        assets[asset_id] = {
            "id": asset_id,
            "name": field_string(entry.get("name"), f"assets-library.assets.{asset_id}.name", asset_id, 120),
            "kind": kind,
            "format": field_string(entry.get("format"), f"assets-library.assets.{asset_id}.format", None, 10).lower(),
            "provider": field_string(entry.get("provider"), f"assets-library.assets.{asset_id}.provider", None, 30),
            "resolution": field_string(entry.get("resolution"), f"assets-library.assets.{asset_id}.resolution", None, 10),
            "object": field_optional_string(entry.get("object"), f"assets-library.assets.{asset_id}.object", 120),
            "bbox": normalize_asset_bbox(entry.get("bbox"), f"assets-library.assets.{asset_id}.bbox"),
            "license": {
                "assetId": asset_id,
                "name": field_string(entry.get("name"), f"assets-library.assets.{asset_id}.name", asset_id, 120),
                "provider": field_string(entry.get("provider"), f"assets-library.assets.{asset_id}.provider", None, 30),
                "sourceUrl": field_string(source.get("url"), f"assets-library.assets.{asset_id}.source.url", None, 500),
                "author": field_string(source.get("author"), f"assets-library.assets.{asset_id}.source.author", None, 200),
                "license": license_name,
                "licenseUrl": field_string(source.get("licenseUrl"), f"assets-library.assets.{asset_id}.source.licenseUrl", None, 500),
            },
        }
    return {"dir": os.path.dirname(os.path.abspath(path)), "assetsDir": assets_dir, "assets": assets}


def load_index(library):
    path = os.path.join(library["dir"], library["assetsDir"], "index.json")
    if not os.path.isfile(path):
        return {"assets": {}}
    raw = load_json(path, "assets/index.json")
    if not is_object(raw) or not is_object(raw.get("assets")):
        raise PlanError("assets/index.json: estrutura inválida; rode `node assets.js fetch` novamente")
    return raw


def local_main(library, index, asset_id):
    entry = index.get("assets", {}).get(asset_id)
    if not entry or not isinstance(entry.get("main"), str):
        return None
    root = os.path.join(library["dir"], library["assetsDir"])
    resolved = os.path.normpath(os.path.join(root, entry["main"]))
    if not resolved.startswith(os.path.abspath(root) + os.sep):
        raise PlanError(f"assets/index.json: caminho fora de {root}: {entry['main']}")
    return resolved


# ---------------------------------------------------------------------------
# Resolução da geometria (sem bpy)
# ---------------------------------------------------------------------------


def opening_center(room, side, opening):
    width = room["interior"]["width"]
    depth = room["interior"]["depth"]
    if side in ("north", "south"):
        x = -width / 2 + opening["u"] + opening["width"] / 2
        y = -depth / 2 if side == "north" else depth / 2
        return [x, y, opening["bottom"] + opening["height"] / 2]
    y = -depth / 2 + opening["u"] + opening["width"] / 2
    x = width / 2 if side == "east" else -width / 2
    return [x, y, opening["bottom"] + opening["height"] / 2]


def wall_box(room, side, thickness):
    width = room["interior"]["width"]
    depth = room["interior"]["depth"]
    height = room["interior"]["height"]
    if side == "north":
        return {"center": [0.0, -depth / 2 - thickness / 2, height / 2], "size": [width + 2 * thickness, thickness, height]}
    if side == "south":
        return {"center": [0.0, depth / 2 + thickness / 2, height / 2], "size": [width + 2 * thickness, thickness, height]}
    if side == "east":
        return {"center": [width / 2 + thickness / 2, 0.0, height / 2], "size": [thickness, depth, height]}
    return {"center": [-width / 2 - thickness / 2, 0.0, height / 2], "size": [thickness, depth, height]}


def opening_geometry(room, side, opening, wall_thickness):
    center = opening_center(room, side, opening)
    profile = opening["frame"]["profile"]
    depth = min(opening["frame"]["depth"], wall_thickness)
    wall_center = wall_box(room, side, wall_thickness)["center"]
    # O cutter atravessa a parede inteira (um pouco além, para o boolean não
    # deixar faces coplanares com a superfície).
    if side in ("north", "south"):
        cutter_size = [opening["width"], wall_thickness + 0.2, opening["height"]]
    else:
        cutter_size = [wall_thickness + 0.2, opening["width"], opening["height"]]
    # Esquadria e vidro ficam no plano médio da parede.
    if side in ("north", "south"):
        frame_center = [center[0], wall_center[1], center[2]]
    else:
        frame_center = [wall_center[0], center[1], center[2]]
    parts = []
    inner_w = opening["width"] - 2 * profile
    inner_h = opening["height"] - 2 * profile
    if side in ("north", "south"):
        size_x = [opening["width"], depth, profile]
        size_z = [profile, depth, opening["height"]]
    else:
        size_x = [depth, opening["width"], profile]
        size_z = [profile, depth, opening["height"]]
    z_bottom = center[2] - opening["height"] / 2
    z_top = center[2] + opening["height"] / 2
    half_w = opening["width"] / 2

    def part(name, offset_axis, offset_value, size, material):
        base = list(frame_center)
        if offset_axis == "horizontal":
            if side in ("north", "south"):
                base[0] += offset_value
            else:
                base[1] += offset_value
        elif offset_axis == "vertical":
            base[2] = offset_value
        elif offset_axis == "in":
            if side in ("north", "south"):
                base[1] = offset_value
            else:
                base[0] = offset_value
        parts.append({"name": name, "center": base, "size": size, "material": material})

    # Moldura externa: 2 montantes + 2 travessas.
    part("montante-esq", "horizontal", -half_w + profile / 2, size_z, opening["frameMaterial"])
    part("montante-dir", "horizontal", half_w - profile / 2, size_z, opening["frameMaterial"])
    part("travessa-baixo", "vertical", z_bottom + profile / 2, size_x, opening["frameMaterial"])
    part("travessa-cima", "vertical", z_top - profile / 2, size_x, opening["frameMaterial"])
    # Montantes internos.
    mullions = opening["frame"]["mullions"]
    for index in range(mullions):
        offset = -half_w + (index + 1) * (opening["width"] / (mullions + 1))
        part(f"montante-{index + 1}", "horizontal", offset, [profile, depth, inner_h], opening["frameMaterial"])
    # Travessa superior (transom).
    transom = opening["frame"]["transom"]
    if transom > 0:
        part("transom", "vertical", z_top - transom, [inner_w + 2 * profile, depth, profile], opening["frameMaterial"])
    glass = None
    if opening["glass"]:
        glass_size = [inner_w, 0.008, inner_h] if side in ("north", "south") else [0.008, inner_w, inner_h]
        glass = {"name": "vidro", "center": list(frame_center), "size": glass_size, "material": opening["glassMaterial"]}
    leaf = None
    if opening["type"] == "door" and opening["leaf"]:
        leaf_size = [opening["width"] - 2 * profile, 0.04, opening["height"]]
        leaf = {"name": "folha-porta", "center": list(frame_center), "size": leaf_size, "material": opening["frameMaterial"]}
    return {
        "id": opening["id"],
        "type": opening["type"],
        "side": side,
        "u": opening["u"],
        "bottom": opening["bottom"],
        "width": opening["width"],
        "height": opening["height"],
        "center": center,
        "cutter": {"center": [frame_center[0], frame_center[1], center[2]], "size": cutter_size},
        "frameCenter": frame_center,
        "frameProfile": profile,
        "frameDepth": depth,
        "frameMaterial": opening["frameMaterial"],
        "glass": glass,
        "leaf": leaf,
        "parts": parts,
    }


def sun_vector(azimuth_degrees, elevation_degrees):
    azimuth = math.radians(azimuth_degrees)
    elevation = math.radians(elevation_degrees)
    return [
        math.sin(azimuth) * math.cos(elevation),
        -math.cos(azimuth) * math.cos(elevation),
        math.sin(elevation),
    ]


def round_number(value, digits=6):
    return round(float(value), digits)


def round_vector(vector, digits=6):
    return [round_number(value, digits) for value in vector]


def resolve_lighting(lighting, room, presets):
    preset = presets[lighting["preset"]]
    overrides = lighting.get("overrides") or {}
    specific = (lighting.get("overridesByPreset") or {}).get(lighting["preset"]) or {}
    sun = dict(preset["sun"])
    if overrides.get("sun"):
        sun.update(overrides["sun"])
    if specific.get("sun"):
        sun.update(specific["sun"])
    world = dict(preset["world"])
    if overrides.get("world"):
        world.update(overrides["world"])
    if specific.get("world"):
        world.update(specific["world"])
    window_fill = dict(preset["windowFill"])
    if overrides.get("windowFill"):
        window_fill.update(overrides["windowFill"])
    if specific.get("windowFill"):
        window_fill.update(specific["windowFill"])
    preset_exposure = specific.get("exposure")
    if preset_exposure is None:
        preset_exposure = overrides.get("exposure")
    if preset_exposure is None:
        preset_exposure = preset["exposure"]
    interior_multiplier = preset["interiorMultiplier"]
    room_center = [0.0, 0.0, room["interior"]["height"] * 0.45]
    direction = sun_vector(sun["azimuth"], sun["elevation"])
    sun_position = [room_center[i] + direction[i] * 30 for i in range(3)]

    window = None
    for side in SIDES:
        wall = next(item for item in room["walls"] if item["side"] == side)
        opening = next((item for item in wall["openings"] if item["type"] == "window"), None)
        if opening is not None:
            window = (side, opening)
            break
    fill_light = None
    if window_fill["enabled"] and window is not None:
        side, opening = window
        center = opening_center(room, side, opening)
        inward = {
            "north": (0.0, 1.0),
            "south": (0.0, -1.0),
            "east": (-1.0, 0.0),
            "west": (1.0, 0.0),
        }[side]
        fill_light = {
            "name": "ceu-janela",
            "type": "AREA",
            "position": [center[0] + inward[0] * 0.35, center[1] + inward[1] * 0.35, opening["bottom"] + opening["height"] * 0.55],
            "energy": window_fill["energy"],
            "size": max(0.5, min(window_fill["size"], max(opening["width"], opening["height"]))),
            "color": window_fill["color"],
            "target": [0.0, 0.0, room["interior"]["height"] * 0.35],
        }
    fixtures = []
    for fixture in lighting["interiorFixtures"]:
        if not fixture["enabled"] or fixture["watts"] <= 0 or interior_multiplier <= 0:
            continue
        fixtures.append({
            "name": f'luminaria-{fixture["id"]}',
            "type": fixture["type"],
            "position": fixture["position"],
            "energy": fixture["watts"] * interior_multiplier,
            "size": fixture["size"],
            "color": fixture["color"],
            "target": fixture["target"] or [0.0, 0.0, room["interior"]["height"] * 0.35],
            "spotSize": fixture["spotSize"],
            "spotBlend": fixture["spotBlend"],
            "sourceWatts": fixture["watts"],
        })
    lights = []
    if sun["enabled"]:
        lights.append({
            "name": "sol",
            "type": "SUN",
            "position": sun_position,
            "energy": sun["strength"],
            "size": 0.5,
            "angle": sun["angle"],
            "color": sun["color"],
            "target": room_center,
            "sourceWatts": None,
        })
    if fill_light is not None:
        lights.append({**fill_light, "angle": 0.526, "sourceWatts": None})
    lights.extend(fixtures)
    hdri = lighting["hdri"]
    hdri_id = hdri if isinstance(hdri, str) else (hdri.get(lighting["preset"]) if hdri else None)
    return {
        "preset": lighting["preset"],
        "label": preset["label"],
        "exposure": preset_exposure,
        "interiorMultiplier": interior_multiplier,
        "sun": {**sun, "position": sun_position, "direction": direction, "target": room_center},
        "world": {
            **world,
            "hdri": hdri_id,
            "rotation": lighting["environmentRotation"],
        },
        "windowFill": {**window_fill, "light": fill_light},
        "fixtures": fixtures,
        "lights": lights,
    }


def asset_world_bbox(entry, transform):
    bbox = entry.get("bbox")
    if not bbox:
        return None
    native_min = bbox["min"]
    native_max = bbox["max"]
    native_height = native_max[2] - native_min[2]
    scale = float(transform["scale"])
    if transform.get("fitHeight") and native_height > 1e-9:
        scale = float(transform["fitHeight"]) / native_height
    angle = math.radians(float(transform["rotation"][2]))
    cos_a = math.cos(angle)
    sin_a = math.sin(angle)
    xs = []
    ys = []
    zs = []
    for x in (native_min[0], native_max[0]):
        for y in (native_min[1], native_max[1]):
            for z in (native_min[2], native_max[2]):
                xs.append((x * cos_a - y * sin_a) * scale)
                ys.append((x * sin_a + y * cos_a) * scale)
                zs.append(z * scale)
    if transform.get("anchor") == "bottom":
        center_x = (min(xs) + max(xs)) / 2
        center_y = (min(ys) + max(ys)) / 2
        offset = [transform["position"][0] - center_x, transform["position"][1] - center_y, transform["position"][2] - min(zs)]
    else:
        offset = list(transform["position"])
    return {
        "min": [min(xs) + offset[0], min(ys) + offset[1], min(zs) + offset[2]],
        "max": [max(xs) + offset[0], max(ys) + offset[1], max(zs) + offset[2]],
        "scale": scale,
    }


def resolve_assets(assets, library, index, events=None):
    placements = []
    missing = []
    seen_licenses = {}
    for placement in assets:
        asset_id = placement["assetId"]
        entry = library["assets"].get(asset_id)
        if entry is None:
            raise PlanError(f'assets[{placement["id"]}]: asset "{asset_id}" não existe em assets-library.json')
        if entry["kind"] != "model":
            raise PlanError(f'assets[{placement["id"]}]: "{asset_id}" é {entry["kind"]}, não é modelo')
        main = local_main(library, index, asset_id)
        exists = bool(main and os.path.isfile(main))
        if not exists:
            missing.append(asset_id)
            if events is not None:
                events.warning(f'asset "{asset_id}" não baixado (rode `node assets.js fetch`); colocação "{placement["id"]}" ignorada')
        placements.append({
            "id": placement["id"],
            "assetId": asset_id,
            "name": entry["name"],
            "format": entry["format"],
            "object": entry["object"],
            "main": main,
            "exists": exists,
            "license": entry["license"],
            "bbox": asset_world_bbox(entry, {
                "position": placement["position"],
                "rotation": placement["rotation"],
                "scale": placement["scale"],
                "fitHeight": placement["fitHeight"],
                "anchor": placement["anchor"],
                "snapToFloor": placement["snapToFloor"],
            }),
            "support": placement["support"],
            "transform": {
                "position": placement["position"],
                "rotation": placement["rotation"],
                "scale": placement["scale"],
                "fitHeight": placement["fitHeight"],
                "anchor": placement["anchor"],
                "snapToFloor": placement["snapToFloor"],
                "materialOverride": placement["materialOverride"],
                "visible": placement["visible"],
                "support": placement["support"],
            },
        })
        seen_licenses[asset_id] = entry["license"]
    return placements, missing, seen_licenses


def resolve_exterior(exterior, room):
    if not exterior:
        return None
    balcony_cfg = exterior.get("balcony")
    backdrop_cfg = exterior.get("backdrop")
    width = room["interior"]["width"]
    depth = room["interior"]["depth"]
    height = room["interior"]["height"]
    thickness = room["wallThickness"]
    window = None
    for side in SIDES:
        wall = next(item for item in room["walls"] if item["side"] == side)
        opening = next((item for item in wall["openings"] if item["type"] == "window"), None)
        if opening is not None:
            window = (side, opening)
            break
    if window is None:
        return None
    side, opening = window
    if side != "north":
        return None
    center_x = -width / 2 + opening["u"] + opening["width"] / 2
    outer_y = -depth / 2 - thickness
    result = {"side": side, "balcony": None, "backdrop": None}
    balcony_depth = 0.0
    if balcony_cfg and balcony_cfg.get("enabled"):
        balcony_depth = balcony_cfg["depth"]
        outer_y_balcony = outer_y - balcony_depth
        slab = {
            "center": [center_x, outer_y - balcony_depth / 2, -0.06],
            "size": [opening["width"] + 0.8, balcony_depth, 0.12],
        }
        rail_parts = []
        top_rail = {
            "center": [center_x, outer_y_balcony + 0.03, balcony_cfg["railingHeight"]],
            "size": [opening["width"] + 0.8, 0.06, 0.05],
        }
        rail_parts.append({"name": "corrimao", "center": top_rail["center"], "size": top_rail["size"]})
        bars = balcony_cfg["bars"]
        for index in range(bars):
            fraction = (index + 0.5) / bars if bars > 0 else 0.5
            x = center_x - (opening["width"] + 0.8) / 2 + fraction * (opening["width"] + 0.8)
            rail_parts.append({
                "name": f"grade-{index + 1}",
                "center": [x, outer_y_balcony + 0.03, balcony_cfg["railingHeight"] / 2],
                "size": [0.03, 0.03, balcony_cfg["railingHeight"]],
            })
        result["balcony"] = {"slab": slab, "railParts": rail_parts, "material": balcony_cfg["material"], "height": height}
    if backdrop_cfg and backdrop_cfg.get("enabled"):
        base_y = outer_y - balcony_depth
        hedge = backdrop_cfg["hedge"]
        facade = backdrop_cfg["facade"]
        result["backdrop"] = {
            "hedge": {
                "center": [center_x, base_y - hedge["offset"] - hedge["depth"] / 2, hedge["height"] / 2],
                "size": [hedge["width"], hedge["depth"], hedge["height"]],
                "material": hedge["material"],
            },
            "facade": {
                "center": [center_x, base_y - facade["distance"], facade["height"] / 2],
                "size": [facade["width"], 0.2, facade["height"]],
                "material": facade["material"],
            },
        }
    return result


def resolve_plan(plan, library, index, presets, events=None):
    room = plan["room"]
    thickness = room["wallThickness"]
    walls = []
    for wall in room["walls"]:
        box = wall_box(room, wall["side"], thickness)
        openings = [opening_geometry(room, wall["side"], opening, thickness) for opening in wall["openings"]]
        for opening in openings:
            if wall["side"] in ("north", "south"):
                origin = opening["center"]
                opening["bbox"] = {
                    "min": [origin[0] - opening["width"] / 2, origin[1], origin[2] - opening["height"] / 2],
                    "max": [origin[0] + opening["width"] / 2, origin[1], origin[2] + opening["height"] / 2],
                }
            else:
                origin = opening["center"]
                opening["bbox"] = {
                    "min": [origin[0], origin[1] - opening["width"] / 2, origin[2] - opening["height"] / 2],
                    "max": [origin[0], origin[1] + opening["width"] / 2, origin[2] + opening["height"] / 2],
                }
        walls.append({
            "side": wall["side"],
            "material": wall["material"],
            "length": wall["length"],
            "box": box,
            "openings": openings,
        })
    furniture = []
    for piece in plan["furniture"]:
        furniture.append({
            "id": piece["id"],
            "shape": piece["shape"],
            "size": round_vector(piece["size"]),
            "position": round_vector(piece["position"]),
            "rotation": round_vector(piece["rotation"]),
            "material": piece["material"],
            "bevel": round_number(piece["bevel"]),
            "smooth": piece["smooth"],
            "support": piece["support"],
            "collisionGroup": piece["collisionGroup"],
            "detail": piece["detail"],
            "box": {
                "center": round_vector([piece["position"][0], piece["position"][1], piece["position"][2] + piece["size"][2] / 2]),
                "size": round_vector(piece["size"]),
            },
        })
    assets, missing, licenses = resolve_assets(plan["assets"], library, index, events)
    lighting = resolve_lighting(plan["lighting"], room, presets)
    hdri_entry = None
    if lighting["world"]["hdri"]:
        hdri_entry = library["assets"].get(lighting["world"]["hdri"])
        if hdri_entry is None:
            raise PlanError(f'lighting.hdri: asset "{lighting["world"]["hdri"]}" não existe em assets-library.json')
        if hdri_entry["kind"] != "hdri":
            raise PlanError(f'lighting.hdri: "{lighting["world"]["hdri"]}" é {hdri_entry["kind"]}, não é HDRI')
        hdri_main = local_main(library, index, lighting["world"]["hdri"])
        if not hdri_main or not os.path.isfile(hdri_main):
            missing.append(lighting["world"]["hdri"])
            if events is not None:
                events.warning(f'HDRI "{lighting["world"]["hdri"]}" não baixado; mundo usará cor de fallback')
            hdri_main = None
        lighting["world"]["hdriPath"] = hdri_main
        lighting["world"]["license"] = hdri_entry["license"]
    else:
        lighting["world"]["hdriPath"] = None
        lighting["world"]["license"] = None
    exterior = resolve_exterior(plan["exterior"], room)
    total_exposure = round_number(plan["render"]["colorManagement"]["exposure"] + lighting["exposure"])
    return {
        "schemaVersion": SCHEMA_VERSION,
        "name": plan["name"],
        "room": {
            "interior": {**room["interior"]},
            "wallThickness": thickness,
            "floor": {
                "material": room["floor"]["material"],
                "thickness": room["floor"]["thickness"],
                "box": {"center": [0.0, 0.0, -room["floor"]["thickness"] / 2], "size": [room["interior"]["width"], room["interior"]["depth"], room["floor"]["thickness"]]},
            },
            "ceiling": {
                "material": room["ceiling"]["material"],
                "thickness": room["ceiling"]["thickness"],
                "box": {"center": [0.0, 0.0, room["interior"]["height"] + room["ceiling"]["thickness"] / 2], "size": [room["interior"]["width"], room["interior"]["depth"], room["ceiling"]["thickness"]]},
            },
        },
        "walls": walls,
        "furniture": furniture,
        "assets": assets,
        "lighting": {
            "preset": lighting["preset"],
            "label": lighting["label"],
            "exposure": lighting["exposure"],
            "effectiveExposure": total_exposure,
            "interiorMultiplier": lighting["interiorMultiplier"],
            "sun": {**lighting["sun"]},
            "world": {
                "kind": lighting["world"]["kind"],
                "hdri": lighting["world"]["hdri"],
                "hdriPath": lighting["world"]["hdriPath"],
                "strength": round_number(lighting["world"]["strength"]),
                "rotation": round_number(lighting["world"]["rotation"]),
                "color": round_vector(lighting["world"]["color"]),
                "license": lighting["world"]["license"],
            },
            "windowFill": {
                "enabled": lighting["windowFill"]["enabled"],
                "energy": round_number(lighting["windowFill"]["energy"]),
                "size": round_number(lighting["windowFill"]["size"]),
                "color": round_vector(lighting["windowFill"]["color"]),
                "light": lighting["windowFill"]["light"],
            },
            "fixtures": [
                {
                    "name": fixture["name"],
                    "type": fixture["type"],
                    "position": round_vector(fixture["position"]),
                    "energy": round_number(fixture["energy"]),
                    "sourceWatts": fixture["sourceWatts"],
                    "color": round_vector(fixture["color"]),
                }
                for fixture in lighting["fixtures"]
            ],
            "lights": [
                {
                    "name": light["name"],
                    "type": light["type"],
                    "position": round_vector(light["position"]),
                    "energy": round_number(light["energy"]),
                    "size": round_number(light["size"]),
                    "color": round_vector(light["color"]),
                    "target": round_vector(light["target"]) if light.get("target") else None,
                    "sourceWatts": light.get("sourceWatts"),
                }
                for light in lighting["lights"]
            ],
        },
        "camera": plan["camera"],
        "render": {**plan["render"], "effectiveExposure": total_exposure},
        "evaluation": plan["evaluation"],
        "reference": plan["reference"],
        "exterior": exterior,
        "materials": list(plan["materials"].keys()),
        "missingAssets": missing,
        "summary": {
            "walls": len(walls),
            "openings": sum(len(wall["openings"]) for wall in walls),
            "furniture": len(furniture),
            "assets": len(assets),
            "lights": len(lighting["lights"]),
            "preset": lighting["preset"],
            "exposure": lighting["exposure"],
        },
    }


# ---------------------------------------------------------------------------
# Construção no Blender
# ---------------------------------------------------------------------------


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def create_box(name, center, size, material, bevel=0.0, smooth=False, collection=None):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0.0, 0.0, 0.0))
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = (size[0], size[1], size[2])
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.location = tuple(center)
    if bevel > 0:
        modifier = obj.modifiers.new("bevel", "BEVEL")
        modifier.width = float(bevel)
        modifier.segments = 3
        modifier.limit_method = "ANGLE"
        modifier.angle_limit = math.radians(30)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=modifier.name)
    if smooth:
        for polygon in obj.data.polygons:
            polygon.use_smooth = True
    if material is not None:
        obj.data.materials.append(material)
    return obj


def create_cylinder(name, center, size, material, smooth=True):
    radius = max(size[0], size[1]) / 2
    bpy.ops.mesh.primitive_cylinder_add(radius=radius, depth=size[2], vertices=48, location=(0.0, 0.0, 0.0))
    obj = bpy.context.active_object
    obj.name = name
    if abs(size[0] - size[1]) > 1e-9:
        obj.scale = (1.0, size[1] / max(size[0], 1e-9), 1.0)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.location = tuple(center)
    if smooth:
        for polygon in obj.data.polygons:
            polygon.use_smooth = True
    if material is not None:
        obj.data.materials.append(material)
    return obj


def apply_rotation(obj, rotation_degrees):
    obj.rotation_euler = tuple(math.radians(value) for value in rotation_degrees)


def build_materials(plan_materials, events, base_dir):
    materials = {}
    for name, definition in plan_materials.items():
        materials[name] = director.make_material(name, definition, base_dir, events)
    return materials


def build_room_shell(resolved, materials, events):
    events.step("paredes")
    wall_objects = []
    cutters = []
    for wall in resolved["walls"]:
        material = materials.get(wall["material"])
        wall_obj = create_box(f'parede-{wall["side"]}', wall["box"]["center"], wall["box"]["size"], material)
        wall_objects.append(wall_obj)
        for opening in wall["openings"]:
            cutter = create_box(f'abertura-{opening["id"]}', opening["cutter"]["center"], opening["cutter"]["size"], None)
            cutter.hide_render = True
            cutters.append(cutter)
            modifier = wall_obj.modifiers.new(f'boolean-{opening["id"]}', "BOOLEAN")
            modifier.operation = "DIFFERENCE"
            modifier.solver = "EXACT"
            modifier.object = cutter
            bpy.context.view_layer.objects.active = wall_obj
            try:
                bpy.ops.object.modifier_apply(modifier=modifier.name)
            except RuntimeError as error:
                raise PlanError(f'falha ao aplicar boolean da abertura "{opening["id"]}" em {wall["side"]}: {error}') from error
    for cutter in cutters:
        bpy.data.objects.remove(cutter, do_unlink=True)

    events.step("piso-e-teto")
    floor = resolved["room"]["floor"]
    ceiling = resolved["room"]["ceiling"]
    create_box("piso", floor["box"]["center"], floor["box"]["size"], materials.get(floor["material"]))
    create_box("teto", ceiling["box"]["center"], ceiling["box"]["size"], materials.get(ceiling["material"]))

    events.step("aberturas")
    for wall in resolved["walls"]:
        for opening in wall["openings"]:
            for part in opening["parts"]:
                create_box(f'{opening["id"]}-{part["name"]}', part["center"], part["size"], materials.get(part["material"]))
            if opening["glass"]:
                glass = opening["glass"]
                create_box(f'{opening["id"]}-vidro', glass["center"], glass["size"], materials.get(glass["material"]))
            if opening["leaf"]:
                leaf = opening["leaf"]
                create_box(f'{opening["id"]}-folha', leaf["center"], leaf["size"], materials.get(leaf["material"]))
    return wall_objects


def build_furniture(resolved, materials, events):
    events.step("mobiliario")
    for piece in resolved["furniture"]:
        material = materials.get(piece["material"])
        center = piece["box"]["center"]
        size = piece["box"]["size"]
        if piece["shape"] == "cylinder":
            obj = create_cylinder(piece["id"], center, size, material, smooth=piece["smooth"])
        else:
                obj = create_box(piece["id"], center, size, material, bevel=piece["bevel"], smooth=piece["smooth"])
        apply_rotation(obj, piece["rotation"])


def world_bounds(objects):
    if bpy is None or not objects:
        return None
    minimum = Vector((math.inf, math.inf, math.inf))
    maximum = Vector((-math.inf, -math.inf, -math.inf))
    for obj in objects:
        if obj.type != "MESH":
            continue
        matrix = obj.matrix_world
        for corner in obj.bound_box:
            world = matrix @ Vector(corner)
            minimum.x = min(minimum.x, world.x)
            minimum.y = min(minimum.y, world.y)
            minimum.z = min(minimum.z, world.z)
            maximum.x = max(maximum.x, world.x)
            maximum.y = max(maximum.y, world.y)
            maximum.z = max(maximum.z, world.z)
    if minimum.x == math.inf:
        return None
    return minimum, maximum


def import_asset_blend(path, object_name, events):
    before = set(bpy.data.objects)
    try:
        with bpy.data.libraries.load(path, link=False) as (source, destination):
            names = source.objects
            if object_name:
                if object_name not in names:
                    raise PlanError(f'asset "{os.path.basename(path)}" não tem o objeto "{object_name}" (tem: {", ".join(names[:10])})')
                destination.objects = [object_name]
            else:
                destination.objects = list(names)
    except Exception as error:  # noqa: BLE001 - erro do Blender vira PlanError
        raise PlanError(f'falha ao abrir .blend "{path}": {error}') from error
    imported = [obj for obj in bpy.data.objects if obj not in before]
    for obj in imported:
        if obj.name not in bpy.context.scene.collection.objects:
            bpy.context.scene.collection.objects.link(obj)
    events.emit(event="info", message=f"{len(imported)} objeto(s) importado(s) de {os.path.basename(path)}")
    return imported


def import_asset_gltf(path, events):
    before = set(bpy.data.objects)
    try:
        bpy.ops.import_scene.gltf(filepath=path)
    except Exception as error:  # noqa: BLE001
        raise PlanError(f'falha ao importar glTF "{path}": {error}') from error
    imported = [obj for obj in bpy.data.objects if obj not in before]
    events.emit(event="info", message=f"{len(imported)} objeto(s) importado(s) de {os.path.basename(path)}")
    return imported


def import_assets(resolved, materials, events):
    events.step("assets")
    imported_licenses = []
    for placement in resolved["assets"]:
        if not placement["exists"]:
            continue
        if not placement["transform"]["visible"]:
            continue
        path = placement["main"]
        if placement["format"] in ("gltf", "glb"):
            imported = import_asset_gltf(path, events)
        elif placement["format"] == "blend":
            imported = import_asset_blend(path, placement["object"], events)
        else:
            raise PlanError(f'formato de asset não suportado: {placement["format"]}')
        meshes = [obj for obj in imported if obj.type == "MESH"]
        if not meshes:
            events.warning(f'asset "{placement["assetId"]}" não trouxe malha; ignorado')
            continue
        transform = placement["transform"]
        target = transform["position"]
        scale = float(transform["scale"])
        if transform["fitHeight"]:
            minimum, maximum = world_bounds(meshes)
            height = maximum.z - minimum.z
            if height > 1e-6:
                scale = float(transform["fitHeight"]) / height
        for obj in meshes:
            if transform["materialOverride"]:
                material = materials.get(transform["materialOverride"])
                if material is not None:
                    obj.data.materials.clear()
                    obj.data.materials.append(material)
        root = bpy.data.objects.new(f'asset-{placement["id"]}', None)
        root.empty_display_size = 0.1
        bpy.context.scene.collection.objects.link(root)
        root.location = (0.0, 0.0, 0.0)
        for obj in imported:
            if obj.parent is None:
                obj.parent = root
                obj.matrix_parent_inverse.identity()
        root.scale = (scale, scale, scale)
        apply_rotation(root, transform["rotation"])
        bpy.context.view_layer.update()
        if transform["anchor"] == "bottom" or transform["snapToFloor"]:
            minimum, maximum = world_bounds(meshes)
            center = (minimum + maximum) / 2
            root.location = (
                target[0] - center.x,
                target[1] - center.y,
                target[2] - minimum.z,
            )
        else:
            root.location = (target[0], target[1], target[2])
        bpy.context.view_layer.update()
        imported_licenses.append({"placementId": placement["id"], **placement["license"]})
        events.emit(event="info", message=f'asset "{placement["assetId"]}" importado ({placement["license"]["license"]})')
    return imported_licenses


def build_exterior(resolved, materials, events):
    exterior = resolved.get("exterior")
    if not exterior:
        return
    events.step("exterior")
    balcony = exterior.get("balcony")
    if balcony:
        material = materials.get(balcony["material"])
        create_box("sacada-laje", balcony["slab"]["center"], balcony["slab"]["size"], material)
        for part in balcony["railParts"]:
            create_box(f'sacada-{part["name"]}', part["center"], part["size"], material)
    backdrop = exterior.get("backdrop")
    if backdrop:
        hedge = materials.get(backdrop["hedge"]["material"])
        facade = materials.get(backdrop["facade"]["material"])
        events.emit(event="info", message=f'exterior backdrop: hedge={bool(hedge)} facade={bool(facade)} y={backdrop["facade"]["center"][1]}')
        create_box("exterior-hedge", backdrop["hedge"]["center"], backdrop["hedge"]["size"], hedge)
        create_box("exterior-fachada", backdrop["facade"]["center"], backdrop["facade"]["size"], facade)


def build_world(resolved, events):
    world_cfg = resolved["lighting"]["world"]
    scene = bpy.context.scene
    world = scene.world
    if world is None:
        world = bpy.data.worlds.new("World")
        scene.world = world
    world.use_nodes = True
    nodes = world.node_tree.nodes
    links = world.node_tree.links
    background = nodes.get("Background")
    if background is None:
        background = nodes.new("ShaderNodeBackground")
        output = nodes.get("World Output")
        if output is not None:
            links.new(background.outputs.get("Background"), output.inputs.get("Surface"))
    background.inputs["Strength"].default_value = float(world_cfg["strength"])
    background.inputs["Color"].default_value = director.color4(world_cfg["color"])
    hdri_path = world_cfg.get("hdriPath")
    if world_cfg["kind"] == "hdri" and hdri_path and os.path.isfile(hdri_path):
        try:
            image = bpy.data.images.load(hdri_path, check_existing=True)
            environment = nodes.new("ShaderNodeTexEnvironment")
            environment.image = image
            mapping = nodes.new("ShaderNodeMapping")
            mapping.inputs["Rotation"].default_value[2] = math.radians(float(world_cfg["rotation"]))
            coordinates = nodes.new("ShaderNodeTexCoord")
            links.new(coordinates.outputs.get("Generated"), mapping.inputs["Vector"])
            links.new(mapping.outputs.get("Vector"), environment.inputs["Vector"])
            links.new(environment.outputs.get("Color"), background.inputs["Color"])
        except Exception as error:  # noqa: BLE001
            events.warning(f"falha ao carregar HDRI: {error} (fallback: cor)")
    elif world_cfg["kind"] == "hdri":
        events.warning("HDRI não configurado/baixado; mundo usará a cor de fallback")


def build_lighting(resolved, events):
    events.step("light-rig")
    lights = []
    for light in resolved["lighting"]["lights"]:
        lights.append({
            "name": light["name"],
            "type": light["type"],
            "position": light["position"],
            "energy": light["energy"],
            "size": light["size"],
            "color": light["color"],
            "target": light["target"],
            "spotSize": light.get("spotSize", 45),
            "spotBlend": light.get("spotBlend", 0.4),
            "angle": light.get("angle", 0.526),
        })
    director.build_lights({"lights": lights}, events)
    # Luzes de área não devem aparecer na câmera (o disco do "céu-janela"
    # apareceria como um círculo branco atrás do vidro). O preenchimento da
    # janela vira um retângulo macio, do tamanho da abertura.
    for light in lights:
        obj = bpy.data.objects.get(light["name"])
        if obj is None:
            continue
        try:
            obj.visible_camera = False
            obj.visible_glossy = False
            obj.visible_transmission = False
        except AttributeError:
            pass
        if light["name"] == "ceu-janela" and obj.type == "LIGHT":
            try:
                obj.data.shape = "RECTANGLE"
                obj.data.size = float(light["size"])
                obj.data.size_y = float(light["size"]) * 0.92
            except (AttributeError, TypeError):
                pass
    return lights


def render_stage_spec(resolved, stage, device_override=None):
    render = resolved["render"]
    spec = {
        "engine": render["engine"],
        "samples": render["samples"],
        "resolution": render["resolution"],
        "preview": render["preview"],
        "render": {**render["render"]},
        "colorManagement": {
            **render["colorManagement"],
            "exposure": resolved["lighting"]["effectiveExposure"],
        },
        "output": render["output"],
    }
    if device_override:
        spec["render"]["device"] = device_override
    return spec


def write_manifest(out_dir, resolved, stage, info, seconds, file_name, preview_index, payload):
    path = os.path.join(out_dir, "room-manifest.json")
    manifest = {}
    if os.path.isfile(path):
        try:
            with open(path, "r", encoding="utf-8") as handle:
                manifest = json.load(handle)
        except (OSError, ValueError):
            manifest = {}
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    manifest.setdefault("schemaVersion", 1)
    manifest.setdefault("generator", "blender-director/build_room.py")
    manifest.setdefault("createdAt", now)
    manifest["updatedAt"] = now
    manifest["blenderVersion"] = bpy.app.version_string if bpy is not None else "unknown"
    manifest["planName"] = resolved["name"]
    manifest["summary"] = {**resolved["summary"], "missingAssets": resolved["missingAssets"]}
    manifest["room"] = resolved["room"]["interior"]
    manifest["lighting"] = {
        "preset": resolved["lighting"]["preset"],
        "exposure": resolved["lighting"]["effectiveExposure"],
        "sun": resolved["lighting"]["sun"],
        "world": resolved["lighting"]["world"],
        "windowFill": resolved["lighting"]["windowFill"],
        "fixtures": resolved["lighting"]["fixtures"],
    }
    manifest["camera"] = resolved["camera"]
    manifest["render"] = {
        "engine": info["engine"],
        "samples": info["samples"],
        "resolution": info["resolution"],
        "device": info["device"],
        "devices": info.get("devices", []),
    }
    manifest["assets"] = payload.get("licenses", [])
    manifest.setdefault("stages", [])
    entry = {
        "stage": stage,
        "n": preview_index,
        "file": file_name,
        "width": info["resolution"][0],
        "height": info["resolution"][1],
        "samples": info["samples"],
        "seconds": seconds,
        "engine": info["engine"],
        "device": info["device"],
        "renderedAt": now,
    }
    manifest["stages"].append(entry)
    if stage == "final":
        manifest["final"] = entry
    else:
        manifest["lastPreview"] = entry
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    return manifest


# ---------------------------------------------------------------------------
# CLI / main
# ---------------------------------------------------------------------------


def parse_cli(argv):
    args = argv[argv.index("--") + 1:] if "--" in argv else argv[1:]
    parser = argparse.ArgumentParser(prog="build_room.py")
    parser.add_argument("--room", required=True, help="room plan JSON")
    parser.add_argument("--out", help="diretório de saída (obrigatório fora do --dry-run)")
    parser.add_argument("--library", default=os.path.join(SCRIPT_DIR, "assets-library.json"))
    parser.add_argument("--presets", default=os.path.join(SCRIPT_DIR, "light-rig-presets.json"))
    parser.add_argument("--stage", choices=["preview", "final"], default="preview")
    parser.add_argument("--preview-index", type=int, default=1)
    parser.add_argument("--progress-json", action="store_true")
    parser.add_argument("--dry-run", action="store_true", help="valida/resolve o plano e emite JSON, sem Blender")
    parser.add_argument("--resolved", help="grava o plano resolvido neste arquivo")
    parser.add_argument("--strict-assets", action="store_true", help="falha se um asset referenciado não estiver baixado")
    parser.add_argument("--device", choices=["CPU", "GPU"], help="sobrepõe render.render.device")
    parser.add_argument("--validate", action="store_true", help="roda o portão geométrico também no --dry-run")
    parser.add_argument("--skip-validation", action="store_true", help="NÃO recomendado: renderiza sem o portão geométrico")
    parser.add_argument("--save-blend", help="salva scene.blend neste caminho (debug)")
    return parser.parse_args(args)


def load_validator():
    path = os.path.join(SCRIPT_DIR, "validate.py")
    spec = importlib.util.spec_from_file_location("blender_director_validate", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run_gate(resolved, events, out_dir=None):
    validator = load_validator()
    validation, report = validator.validate_resolved(resolved, allow_missing_assets=False)
    events.emit(event="validation", ok=report["ok"], rules=report["rules"], errors=report["errors"][:20], summary=report["summary"])
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
        with open(os.path.join(out_dir, "validation.json"), "w", encoding="utf-8") as handle:
            json.dump(report, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
    if not report["ok"]:
        messages = "; ".join(f'{error["rule"]}: {error["message"]}' for error in report["errors"][:8])
        raise PlanError(f"portão geométrico reprovou o plano ({len(report['errors'])} erro(s)): {messages}")
    return report


def run(args, events):
    started = time.time()
    room_path = os.path.abspath(args.room)
    raw = load_json(room_path, "room plan")
    library = load_library(os.path.abspath(args.library))
    index = load_index(library)
    presets = load_presets(os.path.abspath(args.presets))

    events.step("validacao")
    plan = validate_plan(raw)
    resolved = resolve_plan(plan, library, index, presets, events)
    if args.strict_assets and resolved["missingAssets"]:
        raise PlanError(f"assets ausentes (--strict-assets): {', '.join(resolved['missingAssets'])}")
    resolved["source"] = {"room": room_path, "library": os.path.abspath(args.library), "presets": os.path.abspath(args.presets)}
    if args.resolved:
        os.makedirs(os.path.dirname(os.path.abspath(args.resolved)), exist_ok=True)
        with open(args.resolved, "w", encoding="utf-8") as handle:
            json.dump(resolved, handle, ensure_ascii=False, indent=2)
            handle.write("\n")

    if args.dry_run:
        if args.validate:
            validator = load_validator()
            validation, report = validator.validate_resolved(resolved, allow_missing_assets=True)
            events.emit(event="validation", ok=report["ok"], rules=report["rules"], errors=report["errors"][:20], summary=report["summary"])
            if not report["ok"]:
                raise PlanError(f"portão geométrico reprovou o plano: {report['errors'][0]['message']}")
        sys.stdout.write(json.dumps(resolved, ensure_ascii=False, indent=2) + "\n")
        return resolved

    if bpy is None:
        raise PlanError(
            "build_room.py precisa ser executado dentro do Blender, por exemplo:\n"
            "  blender -b -P tools/blender-director/build_room.py -- --room examples/room-living.json --out runs/sala --stage preview --progress-json\n"
            "Fora do Blender use --dry-run."
        )
    if not args.out:
        raise PlanError("--out é obrigatório para renderizar")

    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "resolved-room.json"), "w", encoding="utf-8") as handle:
        json.dump(resolved, handle, ensure_ascii=False, indent=2)
        handle.write("\n")

    if not args.skip_validation:
        run_gate(resolved, events, out_dir)

    clear_scene()
    events.step("materiais")
    materials = build_materials(plan["materials"], events, os.path.dirname(room_path))
    build_room_shell(resolved, materials, events)
    build_exterior(resolved, materials, events)
    build_furniture(resolved, materials, events)
    licenses = import_assets(resolved, materials, events)
    build_world(resolved, events)
    build_lighting(resolved, events)
    director.build_camera({"camera": resolved["camera"]}, events)
    if args.save_blend:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(args.save_blend))
        events.emit(event="info", message=f"scene.blend salvo em {args.save_blend}")

    render_spec = render_stage_spec(resolved, args.stage, args.device)
    info = director.configure_render(bpy.context.scene, render_spec, args.stage, events)
    index_suffix = f"{int(args.preview_index):03d}"
    file_name = f"preview-{index_suffix}.png" if args.stage == "preview" else f"final-{index_suffix}.png"
    file_path = os.path.join(out_dir, file_name)
    seconds = director.render_image(bpy.context.scene, file_path, events)
    events.preview(file_name) if args.stage == "preview" else events.final(file_name)
    events.metric(
        stage=args.stage,
        samples=info["samples"],
        seconds=seconds,
        engine=info["engine"],
        device=info["device"],
        resolution=info["resolution"],
    )
    payload = {"licenses": licenses, "resolved": resolved}
    write_manifest(out_dir, resolved, args.stage, info, seconds, file_name, args.preview_index, payload)
    elapsed = round(time.time() - started, 3)
    events.emit(event="done", stage=args.stage, seconds=elapsed, summary=resolved["summary"], missingAssets=resolved["missingAssets"])
    return resolved


def main(argv=None):
    argv = sys.argv if argv is None else argv
    try:
        args = parse_cli(argv)
    except SystemExit as exc:
        return int(exc.code or 0)
    events = director.Events(args.progress_json)
    try:
        run(args, events)
        return 0
    except Exception as error:  # noqa: BLE001 - queremos um evento de erro legível
        traceback.print_exc(file=sys.stderr)
        events.emit(event="error", message=str(error), traceback=traceback.format_exc(limit=8))
        return 1


if __name__ == "__main__":
    sys.exit(main())
