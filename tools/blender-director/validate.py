#!/usr/bin/env python3
"""validate.py — portão determinístico que roda ANTES do render.

Lê o `resolved-room.json` produzido por `build_room.py --dry-run` e reprova o
plano com regras geométricas, sem LLM e sem olhar a imagem:

1. `intersection` — AABB de peças de conjuntos diferentes não podem se
   penetrar mais de 2 cm nos três eixos. Peças do mesmo conjunto e detalhes
   aplicados (`detail: true`, ex.: ripa, rodapé) são isentos.
2. `support` — peça de piso toca o chão ou o topo de outra peça (folga ≤ 2 cm,
   com sobreposição em planta). Nada flutuando, nada enterrado.
3. `containment` — nada sai do volume interno da sala.
4. `camera-distance` — a lente fica a ≥ 1,0 m de qualquer sólido móvel.
5. `framing` — objetos-chave da referência (por id) têm os 8 cantos do AABB
   dentro do frustum.
6. `inventory` — peça que passa de 2,6 m precisa estar no inventário da
   referência (`reference.inventory`).
7. `layout` — a altura da câmera e o retângulo projetado da janela precisam
   bater com as medidas tiradas da foto (`reference.measurements`).
8. `assets` — asset referenciado precisa estar baixado e ter bbox declarada.

Uso:
    python3 tools/blender-director/build_room.py --room examples/room-living.json \\
        --dry-run --resolved /tmp/resolved.json
    python3 tools/blender-director/validate.py --resolved /tmp/resolved.json

Exit: 0 = plano válido; 2 = reprovado; 1 = erro de uso/arquivo.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time

SCHEMA_VERSION = 1
INTERSECTION_TOLERANCE = 0.02
SUPPORT_GAP = 0.02
FLOOR_TOLERANCE = 0.02
CONTAINMENT_TOLERANCE = 0.01
CAMERA_MIN_DISTANCE = 1.0
INVENTORY_HEIGHT = 2.6
FRAMING_TOLERANCE = 0.002
WINDOW_IOU_MIN = 0.70
WINDOW_CENTER_TOLERANCE = 0.05
CAMERA_HEIGHT_TOLERANCE = 0.05


def is_object(value):
    return isinstance(value, dict)


def vector3(value, default=None):
    if value is None:
        return default
    if not isinstance(value, list) or len(value) != 3:
        return default
    return [float(item) for item in value]


def bbox_from_center_size(center, size):
    return {
        "min": [center[i] - size[i] / 2 for i in range(3)],
        "max": [center[i] + size[i] / 2 for i in range(3)],
    }


def bbox_min_max(raw):
    if not is_object(raw):
        return None
    low = vector3(raw.get("min"))
    high = vector3(raw.get("max"))
    if low is None or high is None:
        return None
    return {"min": [min(low[i], high[i]) for i in range(3)], "max": [max(low[i], high[i]) for i in range(3)]}


def object_bbox(item):
    if item.get("bbox") is not None:
        return bbox_min_max(item["bbox"])
    box = item.get("box")
    if is_object(box):
        center = vector3(box.get("center"))
        size = vector3(box.get("size"))
        if center is not None and size is not None:
            return bbox_from_center_size(center, size)
    return None


def overlap(a, b):
    return [
        min(a["max"][0], b["max"][0]) - max(a["min"][0], b["min"][0]),
        min(a["max"][1], b["max"][1]) - max(a["min"][1], b["min"][1]),
        min(a["max"][2], b["max"][2]) - max(a["min"][2], b["min"][2]),
    ]


def xy_overlap(a, b):
    return (
        min(a["max"][0], b["max"][0]) - max(a["min"][0], b["min"][0]),
        min(a["max"][1], b["max"][1]) - max(a["min"][1], b["min"][1]),
    )


def point_bbox_distance(point, box):
    dx = max(box["min"][0] - point[0], 0.0, point[0] - box["max"][0])
    dy = max(box["min"][1] - point[1], 0.0, point[1] - box["max"][1])
    dz = max(box["min"][2] - point[2], 0.0, point[2] - box["max"][2])
    return math.sqrt(dx * dx + dy * dy + dz * dz)


def subtract(a, b):
    return [a[i] - b[i] for i in range(3)]


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def cross(a, b):
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]


def normalize(vector):
    length = math.sqrt(dot(vector, vector))
    if length < 1e-12:
        return [0.0, 0.0, -1.0]
    return [value / length for value in vector]


def rotation_matrix(rotation_degrees):
    x, y, z = [math.radians(value) for value in rotation_degrees]
    cx, sx = math.cos(x), math.sin(x)
    cy, sy = math.cos(y), math.sin(y)
    cz, sz = math.cos(z), math.sin(z)
    # Blender XYZ Euler: R = Rz * Ry * Rx
    return [
        [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
        [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
        [-sy, cy * sx, cy * cx],
    ]


def mat_vec(matrix, vector):
    return [sum(matrix[row][column] * vector[column] for column in range(3)) for row in range(3)]


def camera_basis(camera):
    location = vector3(camera.get("location"), [0, 0, 0])
    target = vector3(camera.get("target"))
    if target is not None:
        forward = normalize(subtract(target, location))
        right = normalize(cross(forward, [0, 0, 1]))
        if math.sqrt(dot(right, right)) < 1e-6:
            right = [1, 0, 0]
        up = cross(right, forward)
        return location, forward, right, up
    rotation = rotation_matrix(vector3(camera.get("rotation"), [0, 0, 0]))
    forward = mat_vec(rotation, [0, 0, -1])
    right = mat_vec(rotation, [1, 0, 0])
    up = mat_vec(rotation, [0, 1, 0])
    return location, forward, right, up


class Projector:
    def __init__(self, camera, render):
        self.location, self.forward, self.right, self.up = camera_basis(camera)
        resolution = vector3(render.get("resolution"), [1280, 854])
        self.width, self.height = resolution[0], resolution[1]
        lens = float(camera.get("lens", 50))
        sensor_width = float(camera.get("sensorWidth", 36))
        sensor_height = sensor_width * self.height / self.width
        self.tan_h = sensor_width / (2 * lens)
        self.tan_v = sensor_height / (2 * lens)

    def project(self, point):
        relative = subtract(point, self.location)
        depth = dot(relative, self.forward)
        if depth <= 0.01:
            return None
        x = dot(relative, self.right) / depth / self.tan_h
        y = dot(relative, self.up) / depth / self.tan_v
        return (x, y, depth)

    def project_bbox(self, box):
        corners = []
        for x in (box["min"][0], box["max"][0]):
            for y in (box["min"][1], box["max"][1]):
                for z in (box["min"][2], box["max"][2]):
                    corners.append(self.project([x, y, z]))
        return corners

    def image_rect(self, box):
        projected = [self.project([x, y, z]) for x in (box["min"][0], box["max"][0]) for y in (box["min"][1], box["max"][1]) for z in (box["min"][2], box["max"][2])]
        projected = [item for item in projected if item is not None]
        if not projected:
            return None
        xs = [0.5 + item[0] / 2 for item in projected]
        ys = [0.5 - item[1] / 2 for item in projected]
        return [min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)]


def rect_iou(a, b):
    ax0, ay0, aw, ah = a
    bx0, by0, bw, bh = b
    ax1, ay1 = ax0 + aw, ay0 + ah
    bx1, by1 = bx0 + bw, by0 + bh
    intersection_w = max(0.0, min(ax1, bx1) - max(ax0, bx0))
    intersection_h = max(0.0, min(ay1, by1) - max(ay0, by0))
    intersection = intersection_w * intersection_h
    union = aw * ah + bw * bh - intersection
    return intersection / union if union > 0 else 0.0


def rect_center(rect):
    return (rect[0] + rect[2] / 2, rect[1] + rect[3] / 2)


class Validation:
    def __init__(self):
        self.errors = []
        self.warnings = []

    def error(self, rule, message, ids=None, detail=None):
        self.errors.append({"rule": rule, "message": message, "ids": ids or [], "detail": detail or {}})

    def warning(self, rule, message, ids=None):
        self.warnings.append({"rule": rule, "message": message, "ids": ids or []})


def collect_objects(resolved):
    objects = []
    for piece in resolved.get("furniture", []):
        bbox = object_bbox(piece)
        if bbox is None:
            continue
        objects.append({
            "id": piece.get("id", "peca"),
            "kind": "furniture",
            "bbox": bbox,
            "support": piece.get("support", "floor"),
            "group": piece.get("collisionGroup") or str(piece.get("id", "")).split("-")[0],
            "detail": bool(piece.get("detail", False)),
        })
    for placement in resolved.get("assets", []):
        bbox = object_bbox(placement)
        if bbox is None:
            continue
        objects.append({
            "id": placement.get("id", "asset"),
            "kind": "asset",
            "assetId": placement.get("assetId"),
            "bbox": bbox,
            "support": placement.get("support", "floor"),
            "group": f'asset:{placement.get("assetId", placement.get("id"))}',
            "detail": False,
            "exists": placement.get("exists", False),
        })
    return objects


def flatten_openings(resolved):
    openings = []
    for wall in resolved.get("walls", []):
        for opening in wall.get("openings", []):
            bbox = bbox_min_max(opening.get("bbox"))
            if bbox is None and opening.get("center") and opening.get("width") and opening.get("height"):
                bbox = bbox_from_center_size(opening["center"], [opening["width"], opening.get("depth", 0.01), opening["height"]])
            if bbox is not None:
                openings.append({"id": opening.get("id"), "bbox": bbox, "side": wall.get("side")})
    return openings


def check_containment(resolved, objects, validation):
    room = resolved.get("room", {}).get("interior", {})
    width = float(room.get("width", 0))
    depth = float(room.get("depth", 0))
    height = float(room.get("height", 0))
    limits = {
        "min": [-width / 2 - CONTAINMENT_TOLERANCE, -depth / 2 - CONTAINMENT_TOLERANCE, -CONTAINMENT_TOLERANCE],
        "max": [width / 2 + CONTAINMENT_TOLERANCE, depth / 2 + CONTAINMENT_TOLERANCE, height + CONTAINMENT_TOLERANCE],
    }
    for item in objects:
        box = item["bbox"]
        for axis, name in enumerate(("x", "y", "z")):
            if box["min"][axis] < limits["min"][axis] - CONTAINMENT_TOLERANCE or box["max"][axis] > limits["max"][axis] + CONTAINMENT_TOLERANCE:
                validation.error(
                    "containment",
                    f'{item["id"]} sai do volume interno no eixo {name} (min {box["min"][axis]:.3f}, max {box["max"][axis]:.3f})',
                    [item["id"]],
                    {"bbox": box, "limits": limits},
                )
                break


def check_support(objects, validation):
    for item in objects:
        if item["support"] in ("wall", "ceiling"):
            continue
        bottom = item["bbox"]["min"][2]
        if bottom < -SUPPORT_GAP:
            validation.error("support", f'{item["id"]} está enterrado no piso (base z={bottom:.3f})', [item["id"]])
            continue
        on_floor = bottom <= FLOOR_TOLERANCE
        supported_by = None
        for other in objects:
            if other is item:
                continue
            top = other["bbox"]["max"][2]
            if abs(top - bottom) > SUPPORT_GAP:
                continue
            dx, dy = xy_overlap(item["bbox"], other["bbox"])
            if dx > 0.001 and dy > 0.001:
                supported_by = other["id"]
                break
        if item["support"] == "furniture":
            if supported_by is None:
                validation.error(
                    "support",
                    f'{item["id"]} deveria apoiar em outro móvel, mas não toca nenhum topo (base z={bottom:.3f})',
                    [item["id"]],
                )
        elif not on_floor and supported_by is None:
            validation.error(
                "support",
                f'{item["id"]} está flutuando (base z={bottom:.3f}); não toca o piso nem o topo de outra peça',
                [item["id"]],
                {"bottom": bottom, "support": item["support"]},
            )


def check_intersections(objects, validation):
    for index, first in enumerate(objects):
        for second in objects[index + 1:]:
            if first["group"] == second["group"]:
                continue
            if first["detail"] or second["detail"]:
                continue
            dx, dy, dz = overlap(first["bbox"], second["bbox"])
            if dx > INTERSECTION_TOLERANCE and dy > INTERSECTION_TOLERANCE and dz > INTERSECTION_TOLERANCE:
                validation.error(
                    "intersection",
                    f'{first["id"]} penetra {second["id"]} em x={dx:.3f}, y={dy:.3f}, z={dz:.3f} m',
                    [first["id"], second["id"]],
                    {"overlap": [dx, dy, dz]},
                )


def check_camera_distance(resolved, objects, validation):
    camera = resolved.get("camera", {})
    location = vector3(camera.get("location"))
    if location is None:
        validation.error("camera-distance", "câmera sem location", [])
        return
    for item in objects:
        distance = point_bbox_distance(location, item["bbox"])
        if distance < CAMERA_MIN_DISTANCE - 1e-9:
            validation.error(
                "camera-distance",
                f'câmera a {distance:.3f} m de {item["id"]} (mínimo {CAMERA_MIN_DISTANCE} m)',
                [item["id"]],
                {"distance": round(distance, 4)},
            )


def check_inventory(resolved, objects, validation):
    reference = resolved.get("reference") or {}
    inventory = set(reference.get("inventory") or [])
    for item in objects:
        if item["bbox"]["max"][2] > INVENTORY_HEIGHT and item["id"] not in inventory:
            validation.error(
                "inventory",
                f'{item["id"]} passa de {INVENTORY_HEIGHT} m e não está no inventário da referência',
                [item["id"]],
                {"top": round(item["bbox"]["max"][2], 3)},
            )


def check_framing(resolved, objects, openings, validation):
    reference = resolved.get("reference") or {}
    fully_visible = reference.get("fullyVisible") or []
    if not fully_visible:
        return
    projector = Projector(resolved.get("camera", {}), resolved.get("render", {}))
    lookup = {item["id"]: item["bbox"] for item in objects}
    lookup.update({opening["id"]: opening["bbox"] for opening in openings})
    for object_id in fully_visible:
        bbox = lookup.get(object_id)
        if bbox is None:
            validation.error("framing", f'"{object_id}" está em reference.fullyVisible mas não existe no plano resolvido', [object_id])
            continue
        projected = projector.project_bbox(bbox)
        if any(item is None or abs(item[0]) > 1 + FRAMING_TOLERANCE or abs(item[1]) > 1 + FRAMING_TOLERANCE for item in projected):
            validation.error(
                "framing",
                f'"{object_id}" não aparece inteiro no enquadramento',
                [object_id],
                {"projected": [list(item) if item else None for item in projected]},
            )


def check_layout(resolved, openings, validation):
    reference = resolved.get("reference") or {}
    measurements = reference.get("measurements") or {}
    if not measurements:
        return
    camera = resolved.get("camera", {})
    height = vector3(camera.get("location"))
    if height is None:
        validation.error("layout", "câmera sem location para conferir altura medida", [])
    else:
        target_height = float(measurements.get("cameraHeight", height[2]))
        if abs(height[2] - target_height) > CAMERA_HEIGHT_TOLERANCE:
            validation.error(
                "layout",
                f'altura da câmera {height[2]:.3f} m não bate com a medida da referência {target_height:.3f} m',
                [],
                {"cameraHeight": height[2], "measured": target_height},
            )
    window_rect = measurements.get("windowRect")
    window_opening = next((opening for opening in openings if opening["id"] and "janela" in opening["id"]), None)
    if window_rect and window_opening is not None:
        projector = Projector(camera, resolved.get("render", {}))
        projected = projector.image_rect(window_opening["bbox"])
        if projected is None:
            validation.error("layout", "não foi possível projetar a janela", [window_opening["id"]])
        else:
            iou = rect_iou(projected, window_rect)
            center_a = rect_center(projected)
            center_b = rect_center(window_rect)
            center_error = max(abs(center_a[0] - center_b[0]), abs(center_a[1] - center_b[1]))
            if iou < WINDOW_IOU_MIN or center_error > WINDOW_CENTER_TOLERANCE:
                validation.error(
                    "layout",
                    f'retângulo projetado da janela difere da referência (IoU {iou:.3f}, centro {center_error:.3f})',
                    [window_opening["id"]],
                    {"projected": projected, "measured": window_rect, "iou": round(iou, 4), "centerError": round(center_error, 4)},
                )
            else:
                validation.warning("layout", f'janela projeta IoU {iou:.3f} e centro {center_error:.3f} contra a referência')


def point_inside_volume(point, box, margin=0.02):
    inside_xy = all(box["min"][axis] - margin <= point[axis] <= box["max"][axis] + margin for axis in (0, 1))
    # O eixo pode tocar o topo (objeto apoiado); "dentro" exige estar abaixo dele.
    inside_z = box["min"][2] - margin <= point[2] < box["max"][2] - margin
    return inside_xy and inside_z


def check_assets(resolved, objects, validation, allow_missing_assets):
    furniture = [item for item in objects if item["kind"] == "furniture"]
    for placement in resolved.get("assets", []):
        transform = placement.get("transform") or {}
        axis = vector3(transform.get("position"))
        if axis is None:
            bbox = object_bbox(placement)
            axis = None if bbox is None else [(bbox["min"][i] + bbox["max"][i]) / 2 for i in range(3)]
        if axis is not None:
            for item in furniture:
                if point_inside_volume(axis, item["bbox"]):
                    validation.error(
                        "assets",
                        f'eixo do asset "{placement.get("id")}" {tuple(round(v, 3) for v in axis)} está dentro de "{item["id"]}"',
                        [placement.get("id"), item["id"]],
                        {"axis": axis, "furnitureBbox": item["bbox"]},
                    )
        bbox = object_bbox(placement)
        if bbox is not None and not placement.get("exists", True):
            continue
        if bbox is not None:
            for item in furniture:
                dx, dy, dz = overlap(bbox, item["bbox"])
                if dx > INTERSECTION_TOLERANCE and dy > INTERSECTION_TOLERANCE and dz > INTERSECTION_TOLERANCE:
                    validation.error(
                        "assets",
                        f'volume do asset "{placement.get("id")}" penetra "{item["id"]}" em x={dx:.3f}, y={dy:.3f}, z={dz:.3f} m',
                        [placement.get("id"), item["id"]],
                        {"overlap": [dx, dy, dz]},
                    )
    if allow_missing_assets:
        return
    for item in objects:
        if item["kind"] != "asset":
            continue
        if not item.get("exists", False):
            validation.error("assets", f'asset "{item.get("assetId", item["id"])}" não foi baixado (rode node assets.js fetch)', [item["id"]])
    for placement in resolved.get("assets", []):
        if placement.get("exists") and object_bbox(placement) is None:
            validation.error("assets", f'asset "{placement.get("id")}" sem bbox declarada na biblioteca', [placement.get("id")])


def validate_resolved(resolved, allow_missing_assets=False):
    validation = Validation()
    if not is_object(resolved):
        validation.error("schema", "resolved-room.json deve ser um objeto")
        return validation
    if resolved.get("schemaVersion") != SCHEMA_VERSION:
        validation.error("schema", f"schemaVersion inesperado: {resolved.get('schemaVersion')}")
    objects = collect_objects(resolved)
    openings = flatten_openings(resolved)
    if not objects:
        validation.error("schema", "nenhuma peça resolvida (furniture/assets)")
    check_containment(resolved, objects, validation)
    check_support(objects, validation)
    check_intersections(objects, validation)
    check_camera_distance(resolved, objects, validation)
    check_inventory(resolved, objects, validation)
    check_framing(resolved, objects, openings, validation)
    check_layout(resolved, openings, validation)
    check_assets(resolved, objects, validation, allow_missing_assets)
    rules = {}
    for error in validation.errors:
        rules[error["rule"]] = rules.get(error["rule"], 0) + 1
    return validation, {
        "schemaVersion": SCHEMA_VERSION,
        "generator": "blender-director/validate.py",
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "ok": len(validation.errors) == 0,
        "rules": rules,
        "errors": validation.errors,
        "warnings": validation.warnings,
        "summary": {
            "objects": len(objects),
            "openings": len(openings),
            "errors": len(validation.errors),
            "warnings": len(validation.warnings),
            "allowMissingAssets": bool(allow_missing_assets),
        },
        "measurements": {
            "intersectionTolerance": INTERSECTION_TOLERANCE,
            "supportGap": SUPPORT_GAP,
            "cameraMinDistance": CAMERA_MIN_DISTANCE,
            "inventoryHeight": INVENTORY_HEIGHT,
            "windowIouMin": WINDOW_IOU_MIN,
        },
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description="Portão determinístico do room plan (AABB/geometria) antes do render.")
    parser.add_argument("--resolved", required=True, help="resolved-room.json gerado por build_room.py --dry-run --resolved")
    parser.add_argument("--allow-missing-assets", action="store_true", help="não reprova assets ainda não baixados (apenas para testes de geometria)")
    parser.add_argument("--json", action="store_true", help="imprime o relatório JSON")
    parser.add_argument("--out", help="grava o relatório JSON neste arquivo")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args(sys.argv[1:] if argv is None else argv)
    try:
        with open(args.resolved, "r", encoding="utf-8") as handle:
            resolved = json.load(handle)
    except (OSError, ValueError) as error:
        print(f"erro: não foi possível ler {args.resolved}: {error}", file=sys.stderr)
        return 1
    validation, report = validate_resolved(resolved, allow_missing_assets=args.allow_missing_assets)
    if args.out:
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as handle:
            json.dump(report, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    if not args.quiet:
        print(f'validate.py: {report["summary"]["objects"]} peça(s), {report["summary"]["openings"]} abertura(s)')
        for error in validation.errors:
            print(f'  [FALHA] {error["rule"]}: {error["message"]}')
        for warning in validation.warnings:
            print(f'  [ok] {warning["rule"]}: {warning["message"]}')
        print("resultado: " + ("VÁLIDO" if report["ok"] else "REPROVADO"))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    sys.exit(main())
