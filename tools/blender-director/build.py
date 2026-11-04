#!/usr/bin/env python3
"""build.py — constrói uma cena e renderiza um preview/final no Blender.

Este arquivo roda *dentro* do Blender, em background:

    blender -b --python-exit-code 1 -P tools/blender-director/build.py -- \
        --spec runs/<job>/spec.json --out runs/<job> \
        --stage preview --preview-index 1 --progress-json

Ele fala com o servidor por JSON Lines no stdout:

    {"event":"step","name":"objects"}
    {"event":"preview","file":"preview-001.png"}
    {"event":"metric","samples":32,"seconds":1.8,"engine":"CYCLES",...}

Importante: qualquer mensagem humana vai para o stderr; o stdout é reservado
para os eventos JSON. Assim o renderer.js consegue repassar tudo por SSE sem
misturar com o log do Blender.

O script é intencionalmente tolerante a diferenças entre versões do Blender:
as APIs mais estáveis são usadas e trechos que mudam entre 4.x/5.x têm
fallback com `warning`. Ele não foi executado no Blender real neste
repositório (não há Blender no CI); o modo fixture cobre o contrato de eventos.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
import traceback

try:  # pragma: no cover - só existe dentro do Blender
    import bpy
    from mathutils import Matrix
except ImportError:  # permite `python3 build.py --help` e linters fora do Blender
    bpy = None
    Matrix = None

SCHEMA_VERSION = 1
ONE_HOUR = 3600

# Entradas do Principled BSDF que mudaram de nome entre 3.x e 4.x.
BSDF_INPUTS = {
    "baseColor": ["Base Color"],
    "metallic": ["Metallic"],
    "roughness": ["Roughness"],
    "ior": ["IOR"],
    "transmission": ["Transmission Weight", "Transmission"],
    "subsurface": ["Subsurface Weight", "Subsurface"],
    "coat": ["Coat Weight", "Clearcoat"],
    "sheen": ["Sheen Weight", "Sheen"],
    "anisotropy": ["Anisotropic", "Anisotropy"],
    "normal": ["Normal"],
}


class BuildError(RuntimeError):
    """Erro esperado de construção; vira um evento "error" legível."""


class Events:
    def __init__(self, json_mode: bool):
        self.json_mode = json_mode

    def emit(self, **payload):
        payload.setdefault("ts", round(time.time(), 3))
        if self.json_mode:
            sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
            sys.stdout.flush()
        else:
            message = payload.get("message") or payload.get("name") or payload.get("event")
            sys.stderr.write(f"[blender-director] {payload.get('event')}: {message}\n")
            sys.stderr.flush()

    def step(self, name: str):
        self.emit(event="step", name=name)

    def warning(self, message: str):
        self.emit(event="warning", message=message)

    def preview(self, file: str):
        self.emit(event="preview", file=file)

    def final(self, file: str):
        self.emit(event="final", file=file)

    def metric(self, **fields):
        self.emit(event="metric", **fields)


# ---------------------------------------------------------------------------
# Utilidades gerais
# ---------------------------------------------------------------------------


def parse_cli(argv):
    args = argv[argv.index("--") + 1 :] if "--" in argv else []
    parser = argparse.ArgumentParser(prog="build.py")
    parser.add_argument("--spec", required=True, help="caminho do scene-spec JSON")
    parser.add_argument("--out", required=True, help="diretório de saída do job")
    parser.add_argument("--stage", choices=["preview", "final"], default="preview")
    parser.add_argument("--preview-index", type=int, default=1)
    parser.add_argument("--progress-json", action="store_true", help="emite eventos JSON Lines no stdout")
    return parser.parse_args(args)


def resolve_asset(value: str, spec_dir: str) -> str:
    if not value:
        return value
    if value.startswith(("http://", "https://")):
        return value
    if os.path.isabs(value):
        return value
    return os.path.normpath(os.path.join(spec_dir, value))


def is_local_file(value: str, spec_dir: str) -> bool:
    resolved = resolve_asset(value, spec_dir)
    if resolved.startswith(("http://", "https://")):
        return False
    return os.path.isfile(resolved)


def first_input(node, candidates):
    for name in candidates:
        socket = node.inputs.get(name)
        if socket is not None:
            return socket
    return None


def set_input(node, candidates, value, events=None, label=None):
    """Tenta definir uma entrada por uma lista de nomes alternativos."""
    for name in candidates:
        socket = node.inputs.get(name)
        if socket is None:
            continue
        try:
            socket.default_value = value
            return True
        except (TypeError, ValueError):
            continue
    if events and label:
        events.warning(f'entrada "{label}" não encontrada no Principled BSDF; ignorada')
    return False


def color4(color):
    return (float(color[0]), float(color[1]), float(color[2]), 1.0)


def ensure_uv(mesh, name="UVMap"):
    """Cria UV planar se a malha não tiver UV (primitivas já vêm com UV)."""
    if len(mesh.uv_layers) > 0:
        return
    if len(mesh.vertices) == 0:
        return
    xs = [v.co.x for v in mesh.vertices]
    ys = [v.co.y for v in mesh.vertices]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    span_x = max(max_x - min_x, 1e-6)
    span_y = max(max_y - min_y, 1e-6)
    uv_layer = mesh.uv_layers.new(name=name)
    for polygon in mesh.polygons:
        for loop_index in polygon.loop_indices:
            vertex = mesh.vertices[mesh.loops[loop_index].vertex_index]
            uv_layer.data[loop_index].uv = (
                (vertex.co.x - min_x) / span_x,
                (vertex.co.y - min_y) / span_y,
            )


def link_object(obj):
    bpy.context.scene.collection.objects.link(obj)
    return obj


def point_at(obj, name, target, events=None):
    """Cria um empty e aponta o objeto para ele (track-to)."""
    empty = bpy.data.objects.new(f"alvo_{name}", None)
    empty.empty_display_size = 0.2
    link_object(empty)
    empty.location = tuple(float(v) for v in target)
    constraint = obj.constraints.new(type="TRACK_TO")
    constraint.target = empty
    constraint.track_axis = "TRACK_NEGATIVE_Z"
    constraint.up_axis = "UP_Y"
    return empty


# ---------------------------------------------------------------------------
# Materiais
# ---------------------------------------------------------------------------


def make_texture_node(node_tree, texture, spec_dir, events):
    """Cria o nó de textura e devolve (nó, saída_de_cor ou None, saída_fac ou None)."""
    kind = texture["type"]
    if kind == "image":
        image_path = resolve_asset(texture["path"], spec_dir)
        if not os.path.isfile(image_path):
            events.warning(f'textura não encontrada: {texture["path"]} (ignorada)')
            return None, None, None
        node = node_tree.nodes.new("ShaderNodeTexImage")
        try:
            node.image = bpy.data.images.load(image_path, check_existing=True)
        except RuntimeError as exc:
            events.warning(f'falha ao carregar textura "{texture["path"]}": {exc}')
            node_tree.nodes.remove(node)
            return None, None, None
        try:
            node.projection = "BOX" if texture.get("projection") == "box" else "FLAT"
        except (AttributeError, TypeError):
            pass
        return node, node.outputs.get("Color"), None

    if kind == "checker":
        node = node_tree.nodes.new("ShaderNodeTexChecker")
        node.inputs["Color1"].default_value = color4(texture["color1"])
        node.inputs["Color2"].default_value = color4(texture["color2"])
        node.inputs["Scale"].default_value = float(texture["scale"])
        return node, node.outputs.get("Color"), None

    if kind == "noise":
        node = node_tree.nodes.new("ShaderNodeTexNoise")
        scale_input = node.inputs.get("Scale")
        if scale_input:
            scale_input.default_value = float(texture["scale"])
        detail_input = node.inputs.get("Detail")
        if detail_input:
            detail_input.default_value = float(texture["detail"])
        roughness_input = node.inputs.get("Roughness")
        if roughness_input:
            roughness_input.default_value = float(texture["roughness"])
        distortion_input = node.inputs.get("Distortion")
        if distortion_input:
            distortion_input.default_value = float(texture["distortion"])
        fac = node.outputs.get("Fac")
    elif kind == "voronoi":
        node = node_tree.nodes.new("ShaderNodeTexVoronoi")
        scale_input = node.inputs.get("Scale")
        if scale_input:
            scale_input.default_value = float(texture["scale"])
        fac = node.outputs.get("Distance") or node.outputs.get("Fac")
    elif kind == "wave":
        node = node_tree.nodes.new("ShaderNodeTexWave")
        scale_input = node.inputs.get("Scale")
        if scale_input:
            scale_input.default_value = float(texture["scale"])
        distortion_input = node.inputs.get("Distortion")
        if distortion_input:
            distortion_input.default_value = float(texture["distortion"])
        fac = node.outputs.get("Fac")
    else:
        raise BuildError(f"tipo de textura desconhecido: {kind}")

    ramp = node_tree.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].color = color4(texture["color1"])
    ramp.color_ramp.elements[1].color = color4(texture["color2"])
    if fac is not None:
        node_tree.links.new(fac, ramp.inputs["Fac"])
    return node, ramp.outputs.get("Color"), fac


def make_material(name, definition, spec_dir, events):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    node_tree = material.node_tree
    bsdf = node_tree.nodes.get("Principled BSDF")
    if bsdf is None:
        for node in node_tree.nodes:
            if node.type == "BSDF_PRINCIPLED":
                bsdf = node
                break
    if bsdf is None:
        raise BuildError("nó Principled BSDF não encontrado no material")

    set_input(bsdf, BSDF_INPUTS["baseColor"], color4(definition["baseColor"]))
    set_input(bsdf, BSDF_INPUTS["metallic"], float(definition["metallic"]))
    set_input(bsdf, BSDF_INPUTS["roughness"], float(definition["roughness"]))
    set_input(bsdf, BSDF_INPUTS["ior"], float(definition["ior"]))
    set_input(bsdf, BSDF_INPUTS["transmission"], float(definition["transmission"]))
    set_input(bsdf, BSDF_INPUTS["subsurface"], float(definition["subsurface"]))
    set_input(bsdf, BSDF_INPUTS["coat"], float(definition["coat"]))
    set_input(bsdf, BSDF_INPUTS["sheen"], float(definition["sheen"]))
    set_input(bsdf, BSDF_INPUTS["anisotropy"], float(definition["anisotropy"]))

    emission = definition.get("emission") or {}
    emission_strength = float(emission.get("strength") or 0)
    emission_color = emission.get("color") or [0, 0, 0]
    emission_input = bsdf.inputs.get("Emission Color") or bsdf.inputs.get("Emission")
    if emission_input is not None:
        emission_input.default_value = color4(emission_color)
    strength_input = bsdf.inputs.get("Emission Strength")
    if strength_input is not None:
        strength_input.default_value = emission_strength

    textures = definition.get("textures") or []
    if len(textures) > 1:
        events.warning("apenas a primeira textura de base é aplicada; use 'normal' para o relevo")
    if textures:
        node, color_output, _fac = make_texture_node(node_tree, textures[0], spec_dir, events)
        if color_output is not None:
            base_socket = first_input(bsdf, BSDF_INPUTS["baseColor"])
            if base_socket is not None:
                node_tree.links.new(color_output, base_socket)

    normal = definition.get("normal")
    if normal:
        if normal["type"] == "bump":
            noise = node_tree.nodes.new("ShaderNodeTexNoise")
            scale_input = noise.inputs.get("Scale")
            if scale_input:
                scale_input.default_value = float(normal["scale"])
            bump = node_tree.nodes.new("ShaderNodeBump")
            bump.inputs["Strength"].default_value = float(normal["strength"])
            node_tree.links.new(noise.outputs.get("Fac"), bump.inputs["Height"])
            normal_socket = first_input(bsdf, BSDF_INPUTS["normal"])
            if normal_socket is not None:
                node_tree.links.new(bump.outputs.get("Normal"), normal_socket)
        else:
            image_path = resolve_asset(normal["path"], spec_dir)
            if os.path.isfile(image_path):
                image = bpy.data.images.load(image_path, check_existing=True)
                try:
                    image.colorspace_settings.name = "Non-Color"
                except (TypeError, AttributeError):
                    pass
                image_node = node_tree.nodes.new("ShaderNodeTexImage")
                image_node.image = image
                normal_map = node_tree.nodes.new("ShaderNodeNormalMap")
                normal_map.inputs["Strength"].default_value = float(normal["strength"])
                node_tree.links.new(image_node.outputs.get("Color"), normal_map.inputs["Color"])
                normal_socket = first_input(bsdf, BSDF_INPUTS["normal"])
                if normal_socket is not None:
                    node_tree.links.new(normal_map.outputs.get("Normal"), normal_socket)
            else:
                events.warning(f'normal map não encontrado: {normal["path"]} (ignorado)')

    return material


def build_materials(spec, spec_dir, events):
    materials = {}
    for name, definition in spec.get("materials", {}).items():
        materials[name] = make_material(name, definition, spec_dir, events)
    return materials


# ---------------------------------------------------------------------------
# Objetos, modificadores e Geometry Nodes
# ---------------------------------------------------------------------------


PRIMITIVE_OPERATORS = {
    "cube": lambda: bpy.ops.mesh.primitive_cube_add(size=1.0),
    "sphere": lambda: bpy.ops.mesh.primitive_uv_sphere_add(segments=64, ring_count=32, radius=0.5),
    "cylinder": lambda: bpy.ops.mesh.primitive_cylinder_add(vertices=64, radius=0.5, depth=1.0),
    "plane": lambda: bpy.ops.mesh.primitive_plane_add(size=1.0),
    "cone": lambda: bpy.ops.mesh.primitive_cone_add(vertices=64, radius1=0.5, radius2=0.0, depth=1.0),
    "torus": lambda: bpy.ops.mesh.primitive_torus_add(major_radius=0.5, minor_radius=0.2, major_segments=64, minor_segments=16),
}


def create_object(definition, materials, events):
    name = definition["name"]
    if definition["primitive"]:
        operator = PRIMITIVE_OPERATORS.get(definition["primitive"])
        if operator is None:
            raise BuildError(f"primitiva desconhecida: {definition['primitive']}")
        operator()
        obj = bpy.context.active_object
        obj.name = name
    else:
        mesh = bpy.data.meshes.new(f"{name}_mesh")
        mesh.from_pydata(definition["mesh"]["verts"], [], definition["mesh"]["faces"])
        mesh.validate(verbose=False)
        mesh.update()
        ensure_uv(mesh)
        obj = bpy.data.objects.new(name, mesh)
        link_object(obj)

    transform = definition["transform"]
    scale = transform["scale"]
    if scale != [1.0, 1.0, 1.0]:
        obj.data.transform(Matrix.Diagonal((scale[0], scale[1], scale[2], 1.0)))
        if scale[0] * scale[1] * scale[2] < 0:
            try:
                obj.data.flip_normals()
            except AttributeError:
                events.warning("escala negativa sem flip_normals disponível; normais podem ficar invertidas")
    obj.location = tuple(transform["loc"])
    obj.rotation_euler = tuple(math.radians(value) for value in transform["rot"])

    if definition["smooth"]:
        for polygon in obj.data.polygons:
            polygon.use_smooth = True

    if definition["material"]:
        obj.data.materials.append(materials[definition["material"]])
    else:
        ensure_uv(obj.data)

    return obj


def add_modifiers(obj, modifiers, objects_by_name, events):
    for modifier in modifiers:
        kind = modifier["type"]
        if kind == "bevel":
            item = obj.modifiers.new("Bevel", "BEVEL")
            item.width = float(modifier["width"])
            item.segments = int(modifier["segments"])
            item.limit_method = "ANGLE"
        elif kind == "subsurf":
            item = obj.modifiers.new("Subdivision", "SUBSURF")
            item.levels = int(modifier["levels"])
            item.render_levels = int(modifier["renderLevels"])
        elif kind == "boolean":
            target = objects_by_name.get(modifier["target"])
            if target is None:
                raise BuildError(f'boolean aponta para objeto inexistente: {modifier["target"]}')
            item = obj.modifiers.new("Boolean", "BOOLEAN")
            item.operation = modifier["operation"]
            item.object = target
            item.solver = "EXACT"
        elif kind == "solidify":
            item = obj.modifiers.new("Solidify", "SOLIDIFY")
            item.thickness = float(modifier["thickness"])
            item.offset = float(modifier["offset"])
        elif kind == "array":
            item = obj.modifiers.new("Array", "ARRAY")
            item.count = int(modifier["count"])
            item.use_relative_offset = True
            item.relative_offset_displace = tuple(modifier["offset"])
        else:
            raise BuildError(f"modificador desconhecido: {kind}")


def add_scatter_geometry_nodes(obj, definition, materials, events):
    """Implementa o preset "scatter" com um node group mínimo.

    É o único preset suportado pelo schema v1. Usa nós estáveis de Geometry
    Nodes (Distribute Points on Faces + Instance on Points + Ico Sphere).
    """
    material = materials.get(definition["material"]) if definition.get("material") else None
    group = bpy.data.node_groups.new(f"BD_scatter_{obj.name}", "GeometryNodeTree")
    try:
        group.interface.new_socket(name="Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
        group.interface.new_socket(name="Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    except (AttributeError, TypeError) as exc:
        raise BuildError(f"API de interface de Geometry Nodes indisponível: {exc}") from exc

    nodes = group.nodes
    links = group.links
    input_node = nodes.new("NodeGroupInput")
    output_node = nodes.new("NodeGroupOutput")
    distribute = nodes.new("GeometryNodeDistributePointsOnFaces")
    instance = nodes.new("GeometryNodeInstanceOnPoints")
    ico = nodes.new("GeometryNodeMeshIcoSphere")
    set_material = nodes.new("GeometryNodeSetMaterial")

    links.new(input_node.outputs["Geometry"], distribute.inputs["Mesh"])
    links.new(distribute.outputs["Points"], instance.inputs["Points"])
    links.new(ico.outputs["Mesh"], instance.inputs["Instance"])
    links.new(instance.outputs["Instances"], set_material.inputs["Geometry"])
    links.new(set_material.outputs["Geometry"], output_node.inputs["Geometry"])

    density = float(definition["count"])
    area = 0.0
    for polygon in obj.data.polygons:
        area += polygon.area
    if area > 1e-6:
        density = float(definition["count"]) / area
    density_input = distribute.inputs.get("Density")
    if density_input is not None:
        density_input.default_value = density
    seed_input = distribute.inputs.get("Seed")
    if seed_input is not None:
        seed_input.default_value = int(definition["seed"])
    radius_input = ico.inputs.get("Radius")
    if radius_input is not None:
        radius_input.default_value = float(definition["radius"])
    subdivisions = ico.inputs.get("Subdivisions")
    if subdivisions is not None:
        subdivisions.default_value = 1
    if material is not None:
        material_input = set_material.inputs.get("Material")
        if material_input is not None:
            material_input.default_value = material

    modifier = obj.modifiers.new("Scatter", "NODES")
    modifier.node_group = group
    events.warning(f'geometryNodes preset "scatter" aplicado em "{obj.name}" (validar no Blender real)')


def build_objects(spec, materials, events):
    objects_by_name = {}
    for definition in spec["objects"]:
        obj = create_object(definition, materials, events)
        objects_by_name[definition["name"]] = obj
    for definition in spec["objects"]:
        if definition["modifiers"]:
            add_modifiers(objects_by_name[definition["name"]], definition["modifiers"], objects_by_name, events)
    for definition in spec["objects"]:
        if definition["geometryNodes"]:
            add_scatter_geometry_nodes(objects_by_name[definition["name"]], definition["geometryNodes"], materials, events)
    return objects_by_name


# ---------------------------------------------------------------------------
# Luzes, câmera e mundo
# ---------------------------------------------------------------------------


def build_lights(spec, events):
    for light_definition in spec.get("lights", []):
        kind = light_definition["type"]
        data = bpy.data.lights.new(light_definition["name"], kind)
        data.energy = float(light_definition["energy"])
        data.color = tuple(light_definition["color"])
        if kind == "AREA":
            data.shape = "DISK"
            data.size = float(light_definition["size"])
        elif kind == "POINT":
            data.shadow_soft_size = float(light_definition["size"])
        elif kind == "SPOT":
            data.spot_size = math.radians(float(light_definition["spotSize"]))
            data.spot_blend = float(light_definition["spotBlend"])
            data.shadow_soft_size = float(light_definition["size"])
        elif kind == "SUN":
            data.angle = math.radians(float(light_definition["angle"]))

        obj = bpy.data.objects.new(light_definition["name"], data)
        link_object(obj)
        obj.location = tuple(light_definition["position"])
        if light_definition.get("target"):
            point_at(obj, light_definition["name"], light_definition["target"], events)
        elif light_definition.get("rotation"):
            obj.rotation_euler = tuple(math.radians(value) for value in light_definition["rotation"])


def build_camera(spec, events):
    camera_definition = spec["camera"]
    data = bpy.data.cameras.new("Camera")
    data.lens = float(camera_definition["lens"])
    data.sensor_width = float(camera_definition["sensorWidth"])
    data.sensor_fit = "HORIZONTAL"

    focus_target = None
    obj = bpy.data.objects.new("Camera", data)
    link_object(obj)
    obj.location = tuple(camera_definition["location"])
    if camera_definition.get("target"):
        focus_target = point_at(obj, "camera", camera_definition["target"], events)
    elif camera_definition.get("rotation"):
        obj.rotation_euler = tuple(math.radians(value) for value in camera_definition["rotation"])

    data.dof.use_dof = True
    data.dof.aperture_fstop = float(camera_definition["fstop"])
    if camera_definition.get("focusDistance"):
        data.dof.focus_distance = float(camera_definition["focusDistance"])
    elif camera_definition.get("focus") == "target" and focus_target is not None:
        data.dof.focus_object = focus_target
    else:
        data.dof.focus_distance = 10.0

    scene = bpy.context.scene
    scene.camera = obj
    scene.render.use_motion_blur = bool(camera_definition.get("motionBlur"))
    return obj


def build_world(spec, spec_dir, events):
    scene = bpy.context.scene
    world = scene.world
    if world is None:
        world = bpy.data.worlds.new("World")
        scene.world = world
    world.use_nodes = True
    node_tree = world.node_tree
    background = node_tree.nodes.get("Background")
    if background is None:
        background = node_tree.nodes.new("ShaderNodeBackground")
        output = node_tree.nodes.get("World Output")
        if output is not None:
            node_tree.links.new(background.outputs.get("Background"), output.inputs.get("Surface"))
    background.inputs["Color"].default_value = color4(spec["world"]["color"])
    background.inputs["Strength"].default_value = float(spec["world"]["strength"])

    hdri = spec["world"].get("hdri")
    if hdri:
        if hdri.startswith(("http://", "https://")):
            events.warning("world.hdri deve ser um arquivo local; download automático não é feito (fallback: cor)")
        else:
            path = resolve_asset(hdri, spec_dir)
            if not os.path.isfile(path):
                events.warning(f'HDRI não encontrado: {hdri} (fallback: cor)')
            else:
                try:
                    image = bpy.data.images.load(path, check_existing=True)
                    environment = node_tree.nodes.new("ShaderNodeTexEnvironment")
                    environment.image = image
                    node_tree.links.new(environment.outputs.get("Color"), background.inputs["Color"])
                except (RuntimeError, AttributeError) as exc:
                    events.warning(f"falha ao carregar HDRI: {exc} (fallback: cor)")


# ---------------------------------------------------------------------------
# Render
# ---------------------------------------------------------------------------


def fit_preview_dimensions(width, height, max_size):
    scale = min(1.0, float(max_size) / float(max(width, height)))
    preview_width = max(64, int(round(width * scale)))
    preview_height = max(64, int(round(height * scale)))
    preview_width -= preview_width % 2
    preview_height -= preview_height % 2
    return preview_width, preview_height


def configure_gpu(scene, events):
    try:
        addon = bpy.context.preferences.addons.get("cycles")
    except AttributeError:
        addon = None
    if addon is None:
        events.warning("addon Cycles não encontrado; renderizando em CPU")
        scene.cycles.device = "CPU"
        return "CPU", []

    preferences = addon.preferences
    backend = None
    for candidate in ("OPTIX", "CUDA", "HIP", "ONEAPI", "METAL"):
        try:
            preferences.compute_device_type = candidate
            backend = candidate
            break
        except (TypeError, ValueError):
            continue
    if backend is None:
        events.warning("nenhum backend de GPU disponível (OptiX/CUDA); renderizando em CPU")
        scene.cycles.device = "CPU"
        return "CPU", []

    try:
        preferences.get_devices()
    except (RuntimeError, AttributeError) as exc:
        events.warning(f"falha ao enumerar dispositivos de GPU: {exc}; renderizando em CPU")
        scene.cycles.device = "CPU"
        return "CPU", []

    active = []
    for device in preferences.devices:
        use = device.type == backend
        try:
            device.use = use
        except (AttributeError, TypeError):
            pass
        if use:
            active.append(device.name)
    if not active:
        events.warning(f"nenhum dispositivo {backend} encontrado; renderizando em CPU")
        scene.cycles.device = "CPU"
        return "CPU", []
    scene.cycles.device = "GPU"
    return "GPU", active


def configure_color_management(scene, spec, events):
    settings = spec["colorManagement"]
    view_settings = scene.view_settings
    transform = settings["viewTransform"]
    try:
        view_settings.view_transform = transform
    except (TypeError, ValueError):
        fallback = "AgX" if transform != "AgX" else "Standard"
        events.warning(f'view transform "{transform}" indisponível; usando "{fallback}"')
        try:
            view_settings.view_transform = fallback
        except (TypeError, ValueError):
            pass
    try:
        view_settings.look = settings["look"]
    except (TypeError, ValueError):
        events.warning(f'look "{settings["look"]}" indisponível nesta versão; mantendo o padrão')
    view_settings.exposure = float(settings["exposure"])


def configure_output(scene, spec, events, force_png=False):
    output = spec["output"]
    if force_png:
        output = {"format": "PNG", "transparent": bool(output["transparent"]), "colorDepth": "8"}
    image_settings = scene.render.image_settings
    image_settings.file_format = output["format"]
    scene.render.film_transparent = bool(output["transparent"])
    if output["format"] == "PNG":
        image_settings.color_mode = "RGBA" if output["transparent"] else "RGB"
        try:
            image_settings.color_depth = output["colorDepth"]
        except (TypeError, ValueError):
            events.warning(f'colorDepth {output["colorDepth"]} indisponível; usando 8')
            image_settings.color_depth = "8"
    elif output["format"] == "JPEG":
        image_settings.color_mode = "RGB"
        image_settings.quality = 95
    elif output["format"] == "EXR":
        image_settings.color_mode = "RGBA"
        try:
            image_settings.color_depth = "32"
            image_settings.exr_codec = "ZIP"
        except (TypeError, ValueError):
            pass


def configure_render(scene, spec, stage, events):
    engine = spec["engine"]
    candidates = [engine]
    if engine == "BLENDER_EEVEE_NEXT":
        candidates = ["BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"]
    selected_engine = None
    for candidate in candidates:
        try:
            scene.render.engine = candidate
            selected_engine = candidate
            break
        except (TypeError, ValueError):
            continue
    if selected_engine is None:
        raise BuildError(f'engine "{engine}" indisponível nesta instalação do Blender')
    if selected_engine != engine:
        events.warning(f'engine "{engine}" indisponível; usando "{selected_engine}"')

    width, height = spec["resolution"]
    if stage == "preview":
        width, height = fit_preview_dimensions(width, height, spec["preview"]["maxSize"])
        samples = int(spec["preview"]["samples"])
    else:
        samples = int(spec["samples"])
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.render.resolution_percentage = 100

    device = "CPU"
    active_devices = []
    if selected_engine == "CYCLES":
        cycles = scene.cycles
        cycles.samples = samples
        try:
            cycles.use_adaptive_sampling = bool(spec["render"]["adaptive"])
            if spec["render"]["adaptive"]:
                cycles.adaptive_threshold = 0.01
        except (AttributeError, TypeError):
            events.warning("adaptive sampling indisponível nesta versão")
        try:
            cycles.use_denoising = bool(spec["render"]["denoise"])
            if spec["render"]["denoise"]:
                cycles.denoiser = "OPENIMAGEDENOISE"
        except (AttributeError, TypeError):
            events.warning("denoiser OpenImageDenoise indisponível; render sairá com ruído")
        max_bounces = int(spec["render"]["maxBounces"])
        for attribute in ("max_bounces", "diffuse_bounces", "glossy_bounces", "transmission_bounces"):
            try:
                setattr(cycles, attribute, max_bounces)
            except (AttributeError, TypeError):
                pass
        if spec["render"]["device"] == "GPU":
            device, active_devices = configure_gpu(scene, events)
        else:
            cycles.device = "CPU"
    else:
        try:
            scene.eevee.taa_render_samples = samples
        except AttributeError:
            events.warning("amostras do Eevee indisponíveis nesta versão")

    configure_color_management(scene, spec, events)
    configure_output(scene, spec, events, force_png=(stage == "preview"))
    return {
        "engine": selected_engine,
        "samples": samples,
        "resolution": [width, height],
        "device": device,
        "devices": active_devices,
    }


def render_image(scene, filepath, events):
    scene.render.filepath = filepath
    events.step("render")
    start = time.time()
    bpy.ops.render.render(write_still=True)
    seconds = round(time.time() - start, 3)
    if not os.path.isfile(filepath):
        raise BuildError(f"render não gerou o arquivo esperado: {filepath}")
    if os.path.getsize(filepath) <= 0:
        raise BuildError(f"render gerou arquivo vazio: {filepath}")
    return seconds


# ---------------------------------------------------------------------------
# Manifesto
# ---------------------------------------------------------------------------


def read_manifest(out_dir):
    path = os.path.join(out_dir, "manifest.json")
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as handle:
            value = json.load(handle)
        return value if isinstance(value, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def write_manifest(out_dir, spec, stage, render_info, seconds, file_name, preview_index, events):
    manifest_path = os.path.join(out_dir, "manifest.json")
    manifest = read_manifest(out_dir)
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    manifest.setdefault("schemaVersion", SCHEMA_VERSION)
    manifest.setdefault("generator", "blender-director/build.py")
    manifest.update(
        {
            "schemaVersion": SCHEMA_VERSION,
            "generator": "blender-director/build.py",
            "blenderVersion": bpy.app.version_string,
            "specName": spec.get("name"),
            "engine": render_info["engine"],
            "device": render_info["device"],
            "devices": render_info["devices"],
            "samples": int(spec["samples"]),
            "resolution": list(spec["resolution"]),
            "colorManagement": dict(spec["colorManagement"]),
            "blendFile": "scene.blend",
            "updatedAt": now,
        }
    )
    manifest.setdefault("createdAt", now)

    record = {
        "stage": stage,
        "file": file_name,
        "width": render_info["resolution"][0],
        "height": render_info["resolution"][1],
        "samples": render_info["samples"],
        "seconds": seconds,
        "engine": render_info["engine"],
        "device": render_info["device"],
        "renderedAt": now,
    }
    if stage == "preview":
        record["n"] = preview_index
        previews = [
            item
            for item in manifest.get("previews", [])
            if isinstance(item, dict) and item.get("n") != preview_index
        ]
        previews.append(record)
        previews.sort(key=lambda item: item.get("n", 0))
        manifest["previews"] = previews
        manifest["lastPreview"] = record
    else:
        manifest["final"] = record

    temporary = manifest_path + ".tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
    os.replace(temporary, manifest_path)
    events.emit(event="manifest", file="manifest.json")


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------


def load_spec(path):
    with open(path, "r", encoding="utf-8") as handle:
        spec = json.load(handle)
    if not isinstance(spec, dict):
        raise BuildError("spec deve ser um objeto JSON")
    return spec


def run(args, events):
    started = time.time()
    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, exist_ok=True)
    spec_path = os.path.abspath(args.spec)
    spec = load_spec(spec_path)
    spec_dir = os.path.dirname(spec_path)
    stage = args.stage

    if stage == "preview":
        bpy.ops.wm.read_factory_settings(use_empty=True)
        events.step("reset")
        events.step("materials")
        materials = build_materials(spec, spec_dir, events)
        events.step("objects")
        build_objects(spec, materials, events)
        events.step("lights")
        build_lights(spec, events)
        events.step("camera")
        build_camera(spec, events)
        events.step("world")
        build_world(spec, spec_dir, events)
        scene = bpy.context.scene
        render_info = configure_render(scene, spec, stage, events)
        blend_path = os.path.join(out_dir, "scene.blend")
        bpy.ops.wm.save_as_mainfile(filepath=blend_path, check_existing=False)
        file_name = f"preview-{args.preview_index:03d}.png"
        seconds = render_image(scene, os.path.join(out_dir, file_name), events)
        events.preview(file_name)
        events.metric(
            stage="preview",
            samples=render_info["samples"],
            seconds=seconds,
            engine=render_info["engine"],
            device=render_info["device"],
            resolution=render_info["resolution"],
        )
        write_manifest(out_dir, spec, stage, render_info, seconds, file_name, args.preview_index, events)
    else:
        blend_path = os.path.join(out_dir, "scene.blend")
        if not os.path.isfile(blend_path):
            raise BuildError("scene.blend não encontrado; rode o estágio preview antes do final")
        bpy.ops.wm.open_mainfile(filepath=blend_path)
        scene = bpy.context.scene
        if scene.camera is None:
            raise BuildError("a cena salva não tem câmera; rode o preview novamente")
        render_info = configure_render(scene, spec, stage, events)
        extension = {"PNG": "png", "JPEG": "jpg", "EXR": "exr"}[spec["output"]["format"]]
        file_name = f"final-001.{extension}"
        seconds = render_image(scene, os.path.join(out_dir, file_name), events)
        events.final(file_name)
        events.metric(
            stage="final",
            samples=render_info["samples"],
            seconds=seconds,
            engine=render_info["engine"],
            device=render_info["device"],
            resolution=render_info["resolution"],
        )
        write_manifest(out_dir, spec, stage, render_info, seconds, file_name, args.preview_index, events)

    elapsed = round(time.time() - started, 3)
    events.emit(event="done", stage=stage, seconds=elapsed)


def main(argv=None):
    argv = sys.argv if argv is None else argv
    try:
        args = parse_cli(argv)
    except SystemExit as exc:
        return int(exc.code or 0)

    events = Events(args.progress_json)
    if bpy is None:
        sys.stderr.write(
            "build.py precisa ser executado dentro do Blender, por exemplo:\n"
            "  blender -b -P build.py -- --spec spec.json --out out --progress-json\n"
        )
        return 2

    try:
        run(args, events)
        return 0
    except Exception as error:  # noqa: BLE001 - queremos capturar tudo e emitir evento
        traceback.print_exc(file=sys.stderr)
        events.emit(event="error", message=str(error), traceback=traceback.format_exc(limit=8))
        return 1


if __name__ == "__main__":
    sys.exit(main())
