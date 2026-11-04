# Pesquisa: Blender 3D programático, render fotorrealista e direção por agente

> Documento de apoio ao MVP **Blender Director** em [`tools/blender-director/`](../tools/blender-director/README.md). O alvo de produção é o DSH rodando no **Windows com Blender 5.2.3 LTS**, GPU **NVIDIA RTX 3060 12 GB** e **Cycles/OptiX**. O repositório em si roda em Linux sem Blender — por isso todo o contrato do MVP é testável no modo fixture.
>
> Levantamento feito em **novembro de 2026**, com a documentação `current` do Blender (5.2). A seção [O que foi verificado](#o-que-foi-verificado-e-o-que-ficou-por-verificar) separa o que foi conferido em fonte primária do que depende de validação na máquina Windows.

## Sumário

1. [Resumo executivo](#1-resumo-executivo)
2. [API `bpy`](#2-api-bpy)
3. [Modelagem programática](#3-modelagem-programática)
4. [Materiais PBR](#4-materiais-pbr)
5. [Iluminação](#5-iluminação)
6. [Câmera e óptica](#6-câmera-e-óptica)
7. [Render](#7-render)
8. [Fotorrealismo](#8-fotorrealismo)
9. [Automação e integração com agentes](#9-automação-e-integração-com-agentes)
10. [Armadilhas catalogadas](#10-armadilhas-catalogadas)
11. [Como o Blender Director se posiciona](#11-como-o-blender-director-se-posiciona)
12. [O que foi verificado e o que ficou por verificar](#12-o-que-foi-verificado-e-o-que-ficou-por-verificar)
13. [Referências](#13-referências)

## 1. Resumo executivo

O Blender é hoje uma das poucas ferramentas 3D que combinam um motor de render fisicamente baseado maduro (Cycles), uma API Python onipresente (`bpy`) e execução headless estável. Para um agente que precisa "modelar qualquer coisa, aplicar materiais, iluminar, enquadrar e renderizar", isso permite uma arquitetura simples e auditável:

1. o agente emite um **spec declarativo** (JSON) com cena, materiais, luzes e câmera;
2. um processo headless constrói a cena com `bpy`, salva `.blend` e renderiza um **preview barato** (640 px, 32 spp);
3. o usuário vê o preview e o progresso em tempo real; pode pedir ajustes por **comandos incrementais**;
4. só depois de uma **aprovação humana** o render final (resolução/samples do spec) é liberado.

As decisões técnicas que sustentam esse desenho:

- **Cycles, não Eevee, para o resultado final.** Cycles resolve luz indireta, sombras suaves, transmissão e DOF de forma fisicamente plausível; Eevee é ótimo para iteração rápida, mas depende de aproximações em tela. O caminho realista é Cycles com denoise.
- **Preview como imagem, não como viewport.** Renderizar um still de 640 px a 32 spp em uma RTX 3060 custa segundos, não minutos, e é suficiente para decidir enquadramento, luz e materiais. Stream de viewport em tempo real exigiria addon/socket ou captura de GPU — outra categoria de complexidade.
- **Spec versionado em vez de "execute este Python".** O maior risco de um MCP que expõe `bpy` arbitrário é permitir que o modelo faça qualquer coisa, inclusive apagar a cena, estourar memória ou escrever fora do diretório. Um schema fechado, validado antes do render, erra cedo e é reproduzível.
- **Headless + JSON Lines.** `blender -b -P build.py` com `--python-exit-code` transforma o Blender em um worker de render; eventos JSON no stdout e logs humanos no stderr dão observabilidade sem misturar protocolos.
- **Fotorrealismo é um alvo mensurável, não uma promessa.** Escala real, PBR correto, HDRI, sombras de contato, microdetalhe e pós-processamento aproximam o resultado; SSIM, ΔE, PSNR e LPIPS medem aderência **quando existe referência**, e nenhum deles substitui olhar a imagem.
- **MCPs existentes são úteis, mas não são o mesmo produto.** `blender-mcp` e similares expõem ferramentas/ações a um cliente MCP; o Blender Director é um pipeline de job com gate de aprovação, fila e contrato de cena. As duas abordagens podem conviver (o MCP como interface interativa; o Director como pipeline determinístico).

O restante deste documento aprofunda cada camada, cataloga armadilhas e fecha com uma comparação explícita entre as abordagens de automação.

## 2. API `bpy`

A API Python do Blender é grande, mas o subconjunto relevante para automação de cena é pequeno: `bpy.data` para criar/editar dados, `bpy.ops` para operações que dependem de contexto, o **dependency graph** para ler o resultado avaliado, e o **CLI headless** para executar tudo.

### 2.1 `bpy.data` e coleções

`bpy.data` é o banco de dados do arquivo `.blend`. Cada tipo é uma `bpy_prop_collection` — um mapa ordenado nome → ID:

```python
import bpy

# Acesso por nome
cube = bpy.data.objects["Cube"]
mat = bpy.data.materials["Metal"]

# Criação direta (sem operador, sem depender de contexto)
mesh = bpy.data.meshes.new("MinhaMalha")
obj = bpy.data.objects.new("MeuObjeto", mesh)
bpy.context.scene.collection.objects.link(obj)

# Remoção
bpy.data.objects.remove(obj, do_unlink=True)
```

As coleções importantes: `objects`, `meshes`, `curves`, `materials`, `lights`, `cameras`, `images`, `node_groups`, `scenes`, `worlds`, `collections`. Criar dados por `bpy.data.*.new()` é mais previsível em background do que usar operadores: operadores dependem de contexto (área, modo, seleção), enquanto `bpy.data` não.

O `bpy.data` também expõe `bpy.data.filepath`, `bpy.data.is_saved`, `bpy.data.orphans_purge()` e `bpy.data.batch_remove()`; o `orphans_purge` é útil para não arrastar imagens e malhas órfãs para o `.blend`.

### 2.2 Operadores (`bpy.ops`)

Operadores encapsulam ações do Blender. Muitos são a forma mais curta de criar geometria:

```python
bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0, 0, 0.5))
obj = bpy.context.active_object
obj.name = "Cubo"
```

Características que importam para automação:

- **Contexto.** O operador pode exigir um tipo de área, modo ou objeto ativo. Em background (`-b`) não há área de UI; operadores que dependem de viewport podem falhar.
- **`poll()`.** Antes de chamar, dá para testar `bpy.ops.object.mode_set.poll()`; em scripts robustos, prefira verificar o estado em vez de assumir.
- **Override de contexto.** Desde o 3.2, use `with bpy.context.temp_override(area=..., object=..., selected_objects=[...])` em vez do antigo `override={...}`. Em background, overrides de área ainda assim não criam uma viewport.
- **Efeitos colaterais.** Operadores alteram seleção, modo, undo e às vezes o frame. Em pipeline, registre/restaure o estado ou prefira `bpy.data`.

Regra prática: **criar com `bpy.data`, operar com `bpy.ops`** quando o operador for a única API (ex.: `primitive_*_add`, `transform_apply`, `export_scene.*`, `render.render`).

### 2.3 Dependency graph

O dependency graph (depsgraph) é o grafo avaliado da cena. Ele resolve modificadores, constraints, drivers, geometria de Geometry Nodes e dependências de material. Ler o resultado "como o render vê" exige avaliar:

```python
depsgraph = bpy.context.evaluated_depsgraph_get()
obj_eval = obj.evaluated_get(depsgraph)
mesh_eval = obj_eval.to_mesh()

# ... medir, exportar, inspecionar ...

obj_eval.to_mesh_clear()
```

Pontos de atenção:

- `bpy.context.view_layer.update()` força uma atualização antes de consultar transformações/depsgraph em scripts.
- O depsgraph é **efêmero**: não guarde referências a ele entre frames, carregamentos de arquivo ou mudanças grandes; peça um novo.
- Alterar `obj.data` diretamente não atualiza automaticamente o resultado avaliado até o próximo update.
- Para medir bounding box, contagem de vértices após modificadores ou área de superfície, use a malha avaliada, não a original.

### 2.4 Custom properties

Custom properties (ID properties) são o lugar natural para metadados que o agente quer preservar: intenção da cena, seed, versão do spec, material lógico.

```python
obj["origem"] = "agente"
obj["spec_version"] = 1
obj["tags"] = ["estudio", "produto"]          # listas viram IDPropertyArray
obj["material_logico"] = "metal_polido"

# UI (opcional) para propriedades numéricas
obj.id_properties_ui("spec_version").update(
    min=1, max=10, description="Versão do scene-spec"
)
```

Aceitam int, float, bool, string, arrays e ponteiros para IDs; não aceitam dicionários Python arbitrários (para isso, serialize JSON em string). Custom properties sobrevivem ao `.blend` e são uma boa forma de auditar o que o agente pediu.

### 2.5 Undo

O undo do Blender é interativo e baseado em operadores (`bpy.ops.ed.undo_push(message=...)`, `bpy.ops.ed.undo()`, `bpy.ops.ed.redo()`). Em background, o histórico de undo não é uma fundação confiável: scripts headless normalmente rodam uma vez e terminam, e operadores de render/export podem não empilhar undo como na UI.

Para automação, o "undo" deve ser **do lado de fora**: o spec é a fonte da verdade; um comando incremental gera um novo spec e uma nova cena. O `.blend` salvo é um artefato, não um documento colaborativo. Se for necessário undo real dentro de uma sessão interativa, use um addon com histórico próprio ou `undo_push` explicitamente nos pontos certos.

### 2.6 Execução headless

O padrão para render em servidor:

```bash
blender -b --factory-startup --python-exit-code 1 \
  -P tools/blender-director/build.py -- \
  --spec runs/<job>/spec.json --out runs/<job>/ \
  --stage preview --preview-index 1 --progress-json
```

- `-b` (background) não abre interface; o processo termina quando o script termina.
- `-P` executa um arquivo Python; `--python-expr "..."` executa uma expressão (útil para checagens curtas, ruim para scripts grandes).
- `--factory-startup` ignora preferências/addons do usuário; para um worker, isso melhora reprodutibilidade (mas pode desabilitar addons necessários).
- `--` separa argumentos do Blender dos argumentos do script. `sys.argv` contém a linha inteira; o script deve cortar em `sys.argv.index("--") + 1`.
- `--python-exit-code 1` é **essencial**: sem ele, uma exceção Python pode terminar o Blender com código 0 e o pipeline achar que o render deu certo.

Outros flags úteis: `--factory-startup`, `--debug-*` (diagnóstico), `--enable-autoexec` (só quando confiar no arquivo), `-noaudio`, `-f 1` (renderiza o frame 1), `-a` (animação). Para logs, `--log-level` e `--log-file`.

### 2.7 Exit codes e captura de erros

O contrato do worker deve ser explícito:

```python
import sys, traceback

def main():
    try:
        run()
        return 0
    except Exception as exc:
        traceback.print_exc(file=sys.stderr)
        print(f'{{"event":"error","message":"{exc}"}}', file=sys.stdout, flush=True)
        return 1

if __name__ == "__main__":
    sys.exit(main())
```

Cuidados:

- **stdout é protocolo; stderr é log.** Se o servidor lê JSON Lines no stdout, qualquer `print()` humano no stdout quebra o parser. O Blender também imprime progresso no stdout; o parser tolera linhas não-JSON, mas não misture eventos.
- Um erro de script pode deixar um `.blend` parcial ou um PNG antigo no diretório. O worker deve validar a existência, o tamanho e a assinatura do arquivo antes de anunciar sucesso.
- O servidor de jobs deve tratar `exit code != 0`, `timeout` e ausência do evento de sucesso como falhas distintas.
- `bpy.ops.wm.quit_blender()` não é necessário em background; `sys.exit` no script é suficiente.

## 3. Modelagem programática

O Blender não "entende" uma descrição semântica como "uma caneca de cerâmica com alça". Ele entende malha, curva, modificador, material e transformação. A modelagem programática é a tradução dessa intenção para um conjunto finito de operações geométricas.

### 3.1 Primitivas

As primitivas são o átomo mais barato e confiável:

| Primitiva | Operador | Parâmetros úteis | UVs |
| --- | --- | --- | --- |
| Cubo | `primitive_cube_add` | `size` | Sim |
| Esfera UV | `primitive_uv_sphere_add` | `segments`, `ring_count`, `radius` | Sim |
| Icoesfera | `primitive_ico_sphere_add` | `subdivisions`, `radius` | Sim |
| Cilindro | `primitive_cylinder_add` | `vertices`, `radius`, `depth` | Sim |
| Cone | `primitive_cone_add` | `vertices`, `radius1`, `radius2`, `depth` | Sim |
| Plano | `primitive_plane_add` | `size` | Sim |
| Toro | `primitive_torus_add` | `major_radius`, `minor_radius`, `major_segments` | Sim |

Para cenas de produto, as primitivas cobrem caixas, pedestais, topos e superfícies; a combinação com modificadores e materiais resolve boa parte do catálogo. Elas **não** cobrem formas orgânicas complexas, topologia limpa para deformação, nem detalhes de alta frequência.

### 3.2 `bmesh`

`bmesh` dá acesso direto à malha, sem operadores nem contexto. É a API indicada para gerar/editar geometria de forma determinística:

```python
import bmesh, bpy

bm = bmesh.new()
bmesh.ops.create_cube(bm, size=1.0)
bmesh.ops.bevel(
    bm,
    geom=list(bm.edges),
    offset=0.02,
    segments=3,
    affect="EDGES",
)
mesh = bpy.data.meshes.new("CuboChanfrado")
bm.to_mesh(mesh)
bm.free()
mesh.update()
```

Vantagens: controle fino, reproduzível, sem seleção/modo; desvantagens: mais código, necessidade de entender topologia (normais, índices, manifold). Para bevel, subdivisão e criação de painéis, `bmesh.ops` costuma ser mais estável que empilhar operadores.

### 3.3 Modificadores

Modificadores são a forma mais econômica de aumentar detalhe percebido:

| Modificador | Para quê | Campos críticos | Armadilha |
| --- | --- | --- | --- |
| **Bevel** | Quebrar arestas vivas; realismo de objetos manufaturados | `width`, `segments`, `limit_method` | Largura maior que a espessura local cria auto-interseção. |
| **Subdivision Surface** | Suavizar/arredondar | `levels`, `render_levels` | Aumenta muito a contagem de polígonos no render. |
| **Boolean** | Cortes, furos, subtração | `operation`, `object`, `solver` | Malha não-manifold e coplanaridade produzem artefatos. |
| **Solidify** | Dar espessura a paredes/planos | `thickness`, `offset` | Espessura em escala errada parece papel. |
| **Array** | Repetição (ripas, azulejos) | `count`, offset relativo/constante | Cópias podem sair da câmera sem serem notadas. |

A ordem importa: bevel antes de subsurf suaviza a quina; subsurf antes de bevel suaviza tudo e perde a intenção. Boolean antes de bevel pode gerar arestas irregulares. Em pipeline, documente a ordem ou trate o modificador como "cache" e aplique antes de exportar.

### 3.4 Geometry Nodes

Geometry Nodes é o sistema procedural do Blender: um node tree (`GeometryNodeTree`) que recebe geometria e devolve geometria. Conceitos:

- **Group Input/Output** definem o que entra e sai.
- **Campos (fields)** são avaliações por elemento (posição, índice, normal), não valores únicos.
- **Atributos** carregam dados por ponto/face/aresta (ex.: `density`, `material_index`).
- **Instancing** (Distribute Points on Faces → Instance on Points) é o padrão para scattering.
- **Realização** (Realize Instances) converte instâncias em geometria real quando o formato de saída exige.

É excelente para: grama, pedras, paralelepípedos, detalhes repetidos, variação de material por elemento, padrões. É ruim para: modelagem semântica de um objeto específico, topologia limpa, formas que precisam de arestas exatas. Construir grafos complexos via Python é verboso e sensível a versão; para produção, prefira **assets prontos** (`.blend` com node groups) e parametrize pelas entradas do grupo.

Um grafo mínimo de scattering:

```python
group = bpy.data.node_groups.new("Scatter", "GeometryNodeTree")
group.interface.new_socket("Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
group.interface.new_socket("Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")

nodes = group.nodes
distribute = nodes.new("GeometryNodeDistributePointsOnFaces")
instance = nodes.new("GeometryNodeInstanceOnPoints")
ico = nodes.new("GeometryNodeMeshIcoSphere")
# ... ligar Group Input → Distribute → Instance → Group Output ...
```

O MVP do Blender Director implementa exatamente esse preset (`scatter`) e o marca como "validar no Blender real": a API de nós é estável no 4.x/5.x, mas pequenas diferenças de nomes de sockets entre versões são a regra, não a exceção.

### 3.5 Curvas, sweep e lathe

Curvas são subestimadas para objetos "de catálogo":

- **Sweep:** uma curva 2D (perfil) ao longo de uma curva 3D (caminho) gera cabos, tubos, molduras. No Blender, isso é `bevel_depth`/`bevel_object` na curva ou um Geometry Nodes com `Curve to Mesh`.
- **Lathe (revolução):** um perfil girado em torno de um eixo gera vasos, taças, peças torneadas. O modificador **Screw** faz isso; alternativamente, `bmesh.ops.spin`.
- **Texto:** converter texto em malha e extrudar resolve letreiros e embalagens.

Curvas convertidas para malha (`bpy.ops.object.convert(target="MESH")`) perdem parametrização, mas ficam previsíveis para exportar/renderizar.

### 3.6 Geração por spec: o que dá e o que não dá

O Blender Director usa um schema fechado (primitivas, malhas explícitas, modificadores, GN `scatter`, materiais, luzes, câmera). Isso é suficiente para:

- cenas de estúdio com produtos geométricos;
- variações de cor/materiais/luzes;
- composições com piso, pedestal, fundo e objetos simples;
- previews rápidos para decisão de direção.

Não é suficiente para:

- personagens, tecido com simulação, orgânicos complexos;
- topologia de produção, rigging, animação;
- "qualquer coisa" no sentido literal — isso exigiria biblioteca de assets, modelagem generativa (ex.: modelos 3D por IA) ou um artista.

A promessa honesta é: **o agente monta uma cena plausível a partir de um vocabulário finito e mensurável**, não que ele substitui um modelador.

## 4. Materiais PBR

O Principled BSDF é o shader padrão do Cycles/Eevee e concentra os modelos fisicamente baseados. Entender o que cada entrada faz evita os "materiais de plástico" que denunciam render amador.

### 4.1 Principled BSDF

| Entrada | O que controla | Faixa típica | Observações |
| --- | --- | --- | --- |
| **Base Color** | Albedo dielétrico / tint metálico | sRGB | Em metal, a cor vem da reflexão; não use "cinza 50%" para tudo. |
| **Metallic** | Fração metal/dielétrico | 0 ou 1 | Valores intermediários simulam sujeira/desgaste, mas quebram a física. |
| **Roughness** | Microfaceta: 0 espelho, 1 difuso | 0.05–0.9 | 0 absoluto gera fireflies e looks irreais; metais polidos ~0.1–0.25. |
| **IOR** | Índice de refração do dielétrico | 1.33–1.6 | Água 1.33, vidro 1.5, plástico 1.45–1.55; ignorado em metal. |
| **Transmission Weight** | Transmissão especular (vidro/água) | 0–1 | Exige espessura/volume e sombras corretas; caustics são caras. |
| **Subsurface Weight** | Espalhamento subsuperficial | 0–1 | Pele, cera, mármore; custo alto e aparência dependente de raio/escala. |
| **Coat Weight** | Clearcoat sobre a base | 0–1 | Cerâmica, verniz, pintura automotiva; combine com Coat Roughness. |
| **Sheen Weight** | Retroespalhamento de tecido | 0–1 | Veludo, lã, microfibra; sem sheen, tecido parece plástico. |
| **Anisotropy** | Reflexão direcional | -1–1 | Metal escovado, cabelo; precisa de direção tangente coerente. |
| **Emission** | Luz própria | cor + força | Lâmpadas, telas, neon; cuidado com exposição e ruído. |
| **Normal** | Perturbação da normal | — | Bump ou normal map; conecte em espaço tangente. |
| **Alpha** | Transparência | 0–1 | Diferente de transmission; exige blend mode/alpha clip. |

O nome de algumas entradas mudou entre 3.x e 4.x (`Transmission` → `Transmission Weight`, `Clearcoat` → `Coat Weight`, `Sheen` → `Sheen Weight`, `Anisotropic`). O `build.py` do MVP usa listas de nomes alternativos e avisa quando não encontra o socket — uma defesa necessária porque o alvo é 5.2 e o código pode rodar em 4.x.

### 4.2 Texturas e UVs

- **Procedurais** (Noise, Voronoi, Wave, Checker, Gradient) não precisam de UV e são ótimas para variação, rugosidade e padrões. Escala em unidades de mundo importa: `Scale=6` em uma mesa de 1 m é diferente de 6 em uma parede de 10 m.
- **Imagens** (albedo, roughness, metallic, normal, AO) exigem UVs ou projeção. Primitivas do Blender já vêm com UV; malhas customizadas e resultados de boolean/GN podem perder UV ou herdá-la de forma estranha. O MVP gera uma projeção planar simples para malhas customizadas.
- **Normal maps** são texturas em espaço tangente; o color space precisa ser **Non-Color**, senão o Blender aplica transformação sRGB e a direção da normal fica errada. Bump é uma alternativa procedural barata, mas não substitui um normal map de detalhe real.
- **Displacement** verdadeiro desloca geometria; bump só sombreia. Deslocamento real exige subdivisão/adaptive subdivision e custa memória. Para detalhe de superfície em still, bump/normal costuma bastar.

### 4.3 Bibliotecas e licenças

- **Poly Haven** oferece HDRIs, texturas e modelos com licença **CC0**; é a fonte mais comum para iluminação de estúdio e produtos. A página de licença explica que o conteúdo é livre para uso comercial sem atribuição.
- **ambientCG** também publica texturas PBR em **CC0**, com mapas de albedo, normal, roughness, displacement e ao.
- **Cuidado com licenças de modelos**: CC0 é exceção; muitos assets são "royalty-free" com restrições. Registre a origem e a licença no manifesto do job.

O MVP não baixa assets automaticamente. `world.hdri` e texturas de imagem apontam para arquivos locais; URL externa gera warning e fallback procedural. Isso evita rede, telemetria e dependência de disponibilidade de terceiros no meio do render.

### 4.4 Cor: sRGB, linear e o erro clássico

Cores hex de UI são **sRGB**; o shader espera **linear**. Se você joga `#808080` direto no Base Color, o resultado fica claro demais; se converte duas vezes, fica escuro. O MVP converte hex sRGB → linear na validação e trata arrays `[r,g,b]` como lineares. Imagens de albedo devem ficar em sRGB; normal/roughness/metallic em Non-Color; EXR é linear.

## 5. Iluminação

Iluminação é o que mais separa "render de teste" de "foto". A cena pode estar geometricamente correta e ainda parecer artificial por luz dura, sombras ausentes ou exposição errada.

### 5.1 Tipos de luz e unidades

| Tipo | Modelo | Unidade no Blender | Uso |
| --- | --- | --- | --- |
| **Point** | Omnidirecional, cai com 1/r² | W | Lâmpadas práticas, preenchimento local. |
| **Sun** | Direcional, ângulo finito | W/m² (irradiância) | Sol, luz natural; `angle` controla a suavidade da sombra. |
| **Area** | Emissor de área (softbox) | W | Estúdio, produto; `size` controla a suavidade. |
| **Spot** | Cone com blend | W | Recorte, destaque, contra-luz. |

Energia em watts é potência radiante; a percepção depende da distância, do tamanho da fonte e da exposição. Uma area de 100 W a 2 m não é "mais escura" que 500 W a 4 m — a lei do inverso do quadrado e a área mudam tudo. Para estúdio, pense em **tamanho aparente** e **razão key/fill**, não em um número mágico.

### 5.2 World/HDRI

O world é uma fonte de luz onidirecional. Com um HDRI:

```python
world = bpy.context.scene.world
world.use_nodes = True
bg = world.node_tree.nodes["Background"]
env = world.node_tree.nodes.new("ShaderNodeTexEnvironment")
env.image = bpy.data.images.load(r"C:\assets\studio.hdr")
world.node_tree.links.new(env.outputs["Color"], bg.inputs["Color"])
bg.inputs["Strength"].default_value = 1.0
```

O HDRI fornece iluminação e reflexos coerentes; a resolução importa para reflexos nítidos. Para produto, um HDRI de estúdio + area lights de recorte costuma dar mais controle que só HDRI. Em Cycles, o environment é amostrado por importance sampling; HDRIs com sol pequeno e muito brilho podem gerar ruído e fireflies.

### 5.3 Rig de três pontos e variantes

- **Key:** fonte principal, maior e mais forte; define a direção da sombra.
- **Fill:** mais fraca e difusa, do lado oposto; reduz o contraste sem apagar a forma.
- **Rim/back:** atrás do objeto, separa da parede e desenha a silhueta.
- Variantes: **loop** (key + fill + rim em alturas diferentes), **clamshell** (duas fontes grandes em frente), **rembrandt** (key lateral alta), **natural** (janela + rebatida).

Razões típicas key:fill de 2:1 a 8:1; produto limpo tende a 2:1–4:1, dramático a 8:1. O tamanho da fonte controla a dureza da sombra: softbox grande perto = sombra suave; point pequeno longe = sombra dura.

### 5.4 Exposição, cor e luz natural

- Exposição no color management (`scene.view_settings.exposure`, em EV) altera o resultado todo; +1 EV dobra a luz percebida.
- Temperatura de cor: luz quente (3200 K) e fria (5600–6500 K) criam contraste cromático; misture com intenção.
- Luz natural: sol + céu (HDRI) + rebatida de chão/parede; janela grande é uma softbox natural.
- **Light transport:** o caminho da luz (direto, difuso, glossy, transmissão) determina ruído e custo. Luz indireta e caustics exigem mais bounces/samples; em preview, corte bounces para iterar rápido.

## 6. Câmera e óptica

### 6.1 Focal length, sensor e field of view

O field of view horizontal aproximado é:

```text
FOV = 2 * atan(sensor_width / (2 * focal_length))
```

Para full frame (36 mm de largura):

| Focal | FOV horizontal aprox. | Uso |
| --- | --- | --- |
| 24 mm | 73° | Arquitetura, ambiente, distorção de perspectiva. |
| 35 mm | 54° | Documental, produto em contexto. |
| 50 mm | 40° | "Normal", próximo do olho humano. |
| 85 mm | 24° | Retrato, compressão agradável. |
| 135 mm | 15° | Detalhe, fundo muito desfocado. |

Mudar a distância da câmera e a focal ao mesmo tempo muda a perspectiva; mudar só a focal (mantendo a posição) faz crop/zoom. Para produto, 50–100 mm com câmera afastada evita distorção de borda.

### 6.2 Profundidade de campo (DOF)

DOF depende de abertura (f-stop), distância de foco e distância focal. Menor f-stop = mais desfoque. O Blender usa o círculo de confusão do sensor e o `focus_object`/`focus_distance`:

```python
cam.data.dof.use_dof = True
cam.data.dof.aperture_fstop = 2.8
cam.data.dof.focus_object = empty_alvo
```

Cuidados: foco no objeto errado (especialmente com tracking), f-stop extremo (f/0.95) em cena pequena, e DOF em preview de baixa resolução engana — o desfoque parece menor. Para still de produto, f/5.6–f/11 costuma dar nitidez suficiente; para retrato, f/1.8–f/2.8.

### 6.3 Motion blur, composição e distorção

- **Motion blur** é shutter temporal, não um filtro de imagem; em still estático não aparece, em animação exige samples e pode custar caro. Shutter de 180° a 24 fps = 1/48 s.
- **Composição:** regra dos terços, linhas de fuga, altura de câmera (1,5–1,7 m para olhar humano), espaço negativo, ponto de fuga. O viewer do MVP ainda não tem guias (fase 2), mas o spec permite target/lens.
- **Distorção de lente:** grande angular barata curva linhas; o Blender tem Lens Distortion no compositor, mas para fotorrealismo é melhor escolher uma focal que não distorça ou modelar a distorção com referência.
- **Aberrações** (cromática, vinheta, grão) são pós-processamento; em pequena dose aproximam de fotografia, em excesso viram filtro.

## 7. Render

### 7.1 Cycles vs Eevee

| Critério | Cycles | Eevee (Next) |
| --- | --- | --- |
| Modelo | Path tracing fisicamente baseado | Rasterização com efeitos de tela |
| Luz indireta | Correta (bounces) | Aproximada/probes |
| Reflexos/refração | Fisicamente corretos | Aproximações, screen-space |
| Ruído | Sim, reduz com samples/denoise | Menos ruído temporal, mas artefatos de tela |
| Custo | Alto, escala com samples/pixels/bounces | Baixo/médio, ótimo para preview |
| GPU | OptiX/CUDA/HIP/Metal | GPU de rasterização |
| Uso indicado | Render final fotorrealista | Iteração, animação em tempo real, preview |

Para o objetivo do Blender Director, **Cycles é o motor do render final**; Eevee é útil para preview instantâneo no futuro (não implementado no MVP).

### 7.2 Samples, adaptive sampling e denoise

- Samples controlam o ruído do path tracing; o custo é aproximadamente linear.
- **Adaptive sampling** concentra samples onde há mais variância; um threshold de 0.01–0.05 costuma economizar 20–50% sem perda visível.
- **Denoise** (OpenImageDenoise, OptiX denoiser) remove ruído com passes de albedo/normal; é indispensável em 32–256 spp.
- Em preview, 16–32 spp + denoise é suficiente para decidir; no final, 128–512 spp dependendo da cena.
- Denoise em excesso apaga microdetalhe e cria "plástico"; compare com/sem.

O OpenImageDenoise é CPU/GPU e open source; o OptiX denoiser exige NVIDIA e pode ser mais rápido. O MVP liga `OPENIMAGEDENOISE` por padrão e documenta o fallback.

### 7.3 OptiX e GPU

No Cycles, GPU rendering exige:

1. placa NVIDIA compatível e driver atual;
2. OptiX habilitado nas preferências do Cycles;
3. `scene.cycles.device = 'GPU'`;
4. dispositivos marcados em `preferences.devices` com `use=True`.

A RTX 3060 12 GB comporta cenas de estúdio e texturas 4K, mas não é infinita: BVH, texturas e geometria competem por VRAM. Se faltar memória, o render falha ou cai para CPU. Em headless, a seleção de dispositivo depende de preferências do usuário; o MVP tenta OptiX→CUDA→outros e avisa quando cai para CPU.

### 7.4 Light paths e caustics

- `max_bounces` limita o número total de rebatidas; `diffuse_bounces`, `glossy_bounces`, `transmission_bounces` refinam.
- Menos bounces = mais rápido e mais escuro em interiores; mais bounces = mais realista e mais ruidoso.
- **Caustics** (luz concentrada por vidro/água) são caras e raramente convergem em preview; para still, pode valer usar um truque (luz spot/goal, material emissivo) ou aceitar ruído.
- Clamping de indirect reduz fireflies ao custo de energia; use com moderação.

### 7.5 Color management

- **AgX** é o view transform padrão desde o Blender 4.0 (e segue na linha 5.x): comprime altas luzes, preserva cor e evita o "estouro" do Standard. É a escolha para fotorrealismo.
- **Filmic** foi o padrão anterior; ainda existe para compatibilidade, com look mais "cinematográfico" e menos saturação em altas luzes.
- **Standard** não faz tonemapping: útil para máscaras, testes de cor e composição, mas queima highlights.
- **Look** (contraste) e **exposure** devem ser decididos antes de comparar imagens; um look "Medium High Contrast" muda a percepção de realismo.
- O output para tela é sRGB; para composição, EXR linear. Não aplique transformação de cor duas vezes (uma no render, outra no pós).

### 7.6 Formatos, resolução e tempo

- PNG 8/16 bits: entrega e preview; 16 bits ajuda em gradientes.
- JPEG: web, com perda; não use para avaliação de cor.
- EXR 32-bit: composição, HDR, sem clipping; ideal para pós.
- Resolução: o preview do MVP é 640 px no maior lado; o final é o `resolution` do spec (ex.: 1200×800, 1600×1000, 2400×1500).
- Tempo: dominado por pixels × samples × complexidade de luz/geometria. Uma RTX 3060 costuma renderizar um still de estúdio 1200×800/128 spp em dezenas de segundos a poucos minutos; previews 640/32 em segundos. Meça no manifesto, não estime por "sensação".

## 8. Fotorrealismo

### 8.1 O que separa "bom" de fotorrealista

1. **Escala real.** Objetos, luzes, câmera e texturas na mesma unidade; um copo de 1 m quebra tudo.
2. **PBR correto.** Metais com metallic=1, roughness coerente, IOR plausível, tecido com sheen, cerâmica com coat.
3. **Iluminação com intenção.** Key/fill/rim, tamanho de fonte, HDRI coerente com a cena, sombras de contato.
4. **Microdetalhe.** Imperfeições, variação de roughness, poeira, arranhões, bordas irregulares; superfícies perfeitas parecem CG.
5. **Câmera.** Focal, DOF, exposição, composição, leve aberração/grão; a imagem precisa parecer "tirada", não "gerada".
6. **Cor.** Balanço de branco, contraste, saturação, AgX; nada de preto absoluto ou branco estourado sem intenção.
7. **Pós.** Grão sutil, vinheta leve, nitidez; em excesso, denuncia filtro.

### 8.2 Checklist acionável

- [ ] A cena tem escala e unidades documentadas (metros, watts).
- [ ] Toda superfície tem material com roughness/metallic coerentes.
- [ ] Há uma fonte key identificável e sombras com direção consistente.
- [ ] Existe preenchimento suficiente para ler a forma no lado escuro.
- [ ] O objeto se separa do fundo (rim, contraste ou cor).
- [ ] O HDRI/fundo tem perspectiva e reflexos coerentes com a câmera.
- [ ] A câmera está na altura e na focal certas para o produto.
- [ ] O foco está no ponto de interesse, com DOF plausível.
- [ ] O enquadramento segue uma guia (terços/centro) e tem respiro.
- [ ] Há microdetalhe/imperfeição em pelo menos uma superfície grande.
- [ ] O color management é consistente (AgX, exposure, look).
- [ ] O render foi comparado com uma referência ou com o preview anterior.
- [ ] O denoise não apagou detalhe; o ruído residual é aceitável.
- [ ] A imagem final foi aberta e inspecionada em 100%.
- [ ] Métricas (SSIM/ΔE/PSNR/LPIPS) foram calculadas se houver referência.
- [ ] O tempo/samples/engine/GPU estão registrados no manifesto.

### 8.3 Critério → como verificar → como corrigir

| Critério | Como verificar | Como corrigir |
| --- | --- | --- |
| Escala do objeto | Régua/grid de 1 m; comparar com altura da câmera | Ajustar `transform.scale`/dimensões; documentar unidade |
| Albedo coerente | Amostrar cor no render; comparar com referência | Corrigir Base Color (sRGB→linear), evitar saturação |
| Metais | Reflexo nítido e colorido; sem difusão branca | `metallic=1`, `roughness` baixo, HDRI/ambiente para refletir |
| Roughness | Highlights muito duros ou muito "plástico" | Variar 0.1–0.6; textura de roughness; evitar 0 |
| Transmissão/vidro | Fundo distorcido, sombra/refração | Ativar transmission, espessura, IOR correto; aceitar caustics |
| Subsurface | Pele/cera com borda "morta" | Ajustar weight, radius, scale; não exagerar |
| Coat | Reflexo duplo em cerâmica/verniz | Coat Weight 0.2–0.8 + Coat Roughness |
| Sheen | Tecido parece plástico | Sheen Weight + cor; roughness alto |
| Anisotropia | Metal escovado sem direção | Direção tangente/UV coerente; anisotropy 0.2–0.8 |
| Normal/bump | Detalhe some ou inverte | Non-Color no normal map; força/scale; UV |
| UV | Costuras, esticamento, textura "flutuando" | Smart UV/box projection/UV edit; escala em metros |
| Iluminação key | Sombra sem direção ou dupla | Uma key dominante; remover fill conflitante |
| Sombras de contato | Objeto "flutuando" | Piso próximo, luz de contato, AO sutil |
| Exposição | Highlights estourados / cena cinza | Exposure EV, world strength, luz; AgX |
| DOF | Fundo todo nítido ou foco errado | f-stop, focus_object, distância; validar em resolução final |
| Ruído | Grão em superfícies lisas | Mais samples, denoise, luz maior, bounces |
| Fireflies | Pontos brancos isolados | Aumentar roughness mínima, clamp indirect, fonte maior |
| Cor | Pele/objeto "doente" ou saturado | Balanço de branco, look, saturação, referência |
| Composição | Objeto colado na borda/centro morto | Reposicionar câmera, terços, espaço negativo |
| Realismo geral | Comparação lado a lado com foto | Iterar nos critérios acima; não confiar em uma métrica só |

### 8.4 Métricas objetivas

- **SSIM** (Structural Similarity): compara luminância, contraste e estrutura em janelas locais; 0–1, quanto maior melhor. É sensível a desalinhamento e pode ser "enganado" por blur/ruído uniforme.
- **ΔE** (Delta E, CIEDE2000): distância perceptual entre cores; <1 é praticamente indistinguível, 1–2 é perceptível com atenção, >3 é evidente. Calcule em patches de referência, não na imagem inteira.
- **PSNR**: erro quadrático médio em dB; simples e rápido, mas pouco alinhado com percepção.
- **LPIPS**: distância em features de rede profunda; mais próxima do julgamento humano, porém depende do modelo e do dataset.
- **IoU** mede sobreposição de máscaras/segmentação; **não** mede qualidade fotográfica. Usar IoU como "realismo" é um erro categorial.

Regras práticas:

1. Só compare imagens com o **mesmo enquadramento, exposição e color management**.
2. Use uma referência real ou um render de referência aprovado; sem referência, métrica absoluta não diz muito.
3. Combine uma métrica global (SSIM/LPIPS) com uma local (ΔE em patches) e inspeção visual 100%.
4. Desconfie de SSIM alto com imagem borrada ou de ΔE baixo com composição errada.
5. Registre métricas e parâmetros no manifesto para comparações futuras.

**Não existe "realismo absoluto".** O julgamento depende de referência, tela, contexto e expectativa. O compromisso defensável é: critérios explícitos, iteração com preview, métricas quando há referência e honestidade sobre o que não foi validado.

## 9. Automação e integração com agentes

### 9.1 MCP para Blender

O **Model Context Protocol (MCP)** padroniza como um cliente (ex.: um agente) descobre ferramentas e recursos de um servidor. Um servidor MCP para Blender normalmente expõe ferramentas como "criar objeto", "executar Python", "renderizar" e devolve texto/imagem.

O projeto mais conhecido é [`ahujasid/blender-mcp`](https://github.com/ahujasid/blender-mcp): um addon no Blender abre um socket local, e um servidor MCP traduz chamadas do cliente em comandos para o addon. Vantagens:

- interação em tempo real com uma sessão aberta do Blender;
- o usuário vê a cena mudar na viewport;
- reutiliza o vocabulário do Blender (objetos, materiais, câmera);
- ótimo para exploração e "copiloto".

Riscos:

- **execução de código arbitrário** (muitos servidores expõem `execute_blender_code`); um prompt malicioso ou alucinação pode apagar dados ou rodar comandos no host;
- acoplamento à versão do addon/Blender e ao socket;
- sem schema de cena versionado: o resultado depende do histórico da sessão;
- difícil de reproduzir/auditar e de rodar em fila;
- segurança de rede local (porta aberta, sem auth em muitos casos).

### 9.2 Addons de socket/ponte

Uma ponte própria (addon + WebSocket/TCP) dá controle total: comandos tipados, streaming de viewport, eventos. Custo: manter um addon para cada versão do Blender, tratar reconexão, serialização e segurança. Para "tempo real de verdade" (viewport a 30–60 fps), essa é a abordagem; para render determinístico, não é necessária.

### 9.3 Automação headless

`blender -b -P script.py` é o caminho mais simples e robusto para jobs:

- um processo por job, isolamento de memória;
- sem UI, sem estado de sessão;
- reproduzível com `--factory-startup`;
- fácil de containerizar (Linux) ou agendar (Windows Task Scheduler/CI);
- logs e exit codes controláveis.

Custo: cada job paga o startup do Blender (1–5 s) e não compartilha cena entre jobs. Para muitos jobs pequenos, vale manter um pool de processos ou usar um servidor persistente com fila (o MVP usa um job por vez).

### 9.4 Filas, streaming e limites

- **Fila:** um job por GPU evita disputa de VRAM; o MVP serializa jobs e bloqueia a fila enquanto aguarda aprovação.
- **Timeout:** renders podem travar (driver, cena gigante); sempre limite e mate o processo.
- **Streaming de preview:** renderizar stills em 640/32 e publicar por SSE/HTTP é simple e suficiente para direção. Streaming de viewport exige addon/socket ou captura de framebuffer.
- **Assets:** HDRI/texturas grandes precisam de cache local e verificação de licença; download no meio do job é um ponto de falha.
- **Segurança:** servidor em `127.0.0.1`, sem telemetria, validação de entrada, sem execução de Python arbitrário no spec.

### 9.5 Comparação com o Blender Director

| Aspecto | `blender-mcp` e similares | Blender Director (MVP) |
| --- | --- | --- |
| Interface | Ferramentas MCP em sessão aberta | HTTP + scene-spec JSON |
| Estado | Sessão do Blender (histórico) | Spec versionado + `.blend` por job |
| Reprodução | Depende da conversa/sessão | Determinística a partir do spec |
| Preview | Viewport em tempo real | Still 640/32 por SSE |
| Aprovação | Não é o foco | Gate humano explícito antes do final |
| Segurança | Pode expor execução arbitrária | Schema fechado, sem Python arbitrário |
| Fila | Não é o foco | Fila serial, timeout, erros |
| Assets | Download/uso conforme o addon | Caminhos locais, fallback procedural |
| Melhor uso | Exploração/copiloto | Pipeline de entrega com revisão |

As abordagens são complementares: um MCP pode ser a interface interativa para o artista; o Director é o pipeline auditável para o agente entregar uma cena revisável. O MVP escolheu o segundo porque o requisito é **acompanhamento + aprovação + reprodutibilidade**, não edição ao vivo da viewport.

## 10. Armadilhas catalogadas

| # | Armadilha | Sintoma | Correção |
| --- | --- | --- | --- |
| 1 | Primitiva sem UV / UV perdida após boolean/GN | Textura esticada, preta ou "flutuando" | UV project/box; inspecionar UV; usar procedural |
| 2 | Textura velha em cache / caminho relativo errado | Mudou o arquivo, render não muda | `image.reload()`; caminho absoluto; empacotar no `.blend` |
| 3 | Normais invertidas | Superfície preta, iluminação "de dentro" | Recalcular normais; corrigir winding; evitar escala negativa |
| 4 | Unidades/ escala erradas | DOF, luz e displacement absurdos | Definir metros; conferir `scene.unit_settings`; não misturar cm/m |
| 5 | Render "ok" sem olhar a imagem | Frame preto, câmera errada, alpha transparente | Abrir o PNG; validar tamanho/assinatura; checar câmera/frame |
| 6 | IoU/SSIM enganando | Métrica alta com imagem borrada/desalinhada | Métricas múltiplas; inspeção; referência alinhada |
| 7 | Conflito de dependência de GPU | OptiX indisponível, crash, fallback silencioso | Driver atual; testar Cycles GPU no Blender; logar device |
| 8 | Blender retorna 0 com erro de script | Pipeline acha que renderizou | `--python-exit-code 1`; validar evento/arquivo |
| 9 | Caminho com espaço no Windows | Script não encontra spec/HDRI | Passar como argumento único; `pathlib`; sem `shell=True` |
| 10 | GPU não usada | Render lento em CPU | `scene.cycles.device`, preferências, `get_devices`, VRAM |
| 11 | Color management duplo | Cores lavadas/escuras | sRGB→linear uma vez; Non-Color em dados; AgX no view |
| 12 | Alpha vs transmission | Vidro preto/opaco | Usar Transmission/volume, não Alpha; sombras corretas |
| 13 | Denoise em low samples | Borrão, detalhe plástico | 64–128 spp no preview; comparar com/sem denoise |
| 14 | Fireflies | Pontos brancos | Aumentar roughness mínima, fonte maior, clamp, mais samples |
| 15 | Boolean não-manifold | Buracos/artefatos | Malha limpa, solver EXACT, aplicar bevel com cuidado |
| 16 | Z-fighting/coplanar | Listras no piso/parede | Separar por epsilon; evitar faces coplanares |
| 17 | Ordem de modificadores | Bevel/subsurf com resultado errado | Documentar/ordenar; aplicar antes de exportar |
| 18 | Geometry Nodes sem atributo | Scatter vazio ou densidade errada | Verificar campos/atributos e escala; realizado vs instância |
| 19 | Saída sobrescrita | Só o último frame/arquivo existe | Numerar arquivos; validar manifesto |
| 20 | Render sem timeout | Job trava a fila para sempre | Timeout + kill; logs; retry limitado |
| 21 | HDRI muito pequeno | Reflexos borrados, luz ruidosa | HDRI 4K–8K para still; importance sampling |
| 22 | Textura sRGB em normal map | Relevo invertido/estranho | Color space Non-Color |

## 11. Como o Blender Director se posiciona

| Decisão | Motivo | Limitação |
| --- | --- | --- |
| Spec JSON fechado | Validação precoce, reprodutibilidade, segurança | Vocabulário finito; não modela qualquer coisa |
| Headless por job | Isolamento, fila, timeout, CI sem Blender | Startup por job; sem viewport interativa |
| Cycles + OptiX | Realismo físico, GPU NVIDIA | VRAM 12 GB; driver; caustics caras |
| Preview 640/32 + SSE | Iteração em segundos, decisão de direção | Não é vídeo/viewport; DOF e ruído enganam em baixa resolução |
| Gate de aprovação | Controle humano antes de custo alto | Bloqueia a fila enquanto aguarda |
| Comandos incrementais | "Tempo real" percebido sem abrir o Blender | Rebuild do spec a cada comando; sem undo |
| Fixture `fake-blender` | Teste e2e sem GPU/Blender | Não valida imagem real; PNG placeholder |
| Sem download de assets | Sem rede/telemetria; render determinístico | Usuário precisa fornecer HDRI/texturas |
| Manifesto com métricas | Auditoria, comparação, estimativa | Tempo varia com driver/cena; não é benchmark |

O MVP não substitui um DCC interativo nem um artista; ele reduz o custo de **iteração e entrega** de cenas de estúdio/produto em um fluxo onde o humano aprova o preview.

## 12. O que foi verificado e o que ficou por verificar

**Verificado em fonte primária (novembro de 2026):**

- documentação oficial da API `bpy` (5.2), incluindo `bpy.ops`, `bpy.data`, depsgraph, custom properties, contexto e `bmesh`;
- manual do Blender (Cycles, Eevee, Principled BSDF, texturas, UV, modificadores, Geometry Nodes, câmeras, luzes, world, color management, formatos de saída);
- linha de comando e argumentos (`-b`, `-P`, `--python-exit-code`, `--`);
- release notes/documentação da linha 5.2;
- licenças CC0 da Poly Haven e ambientCG;
- OpenImageDenoise, OptiX, pbrt;
- repositório `ahujasid/blender-mcp` e a especificação MCP;
- páginas de referência de SSIM/CIEDE2000 (a IEEE bloqueia acesso automatizado; a referência DOI é citada como registro, não como texto lido);
- todos os links da seção de referências foram conferidos por HTTP (200/301/302 ou registro DOI); exceções estão anotadas.

**Não verificado / limitações:**

- **Não há Blender instalado neste ambiente Linux.** O `build.py` não foi executado no Blender real; ele foi escrito contra a API documentada e o modo fixture cobre apenas o contrato de eventos/arquivos. A primeira execução no Windows com 5.2.3 LTS deve validar: nomes de sockets do Principled BSDF, Geometry Nodes `scatter`, OptiX, `look` de color management, `flip_normals`, `read_factory_settings` e o exit code.
- Não foram feitas medições de tempo em RTX 3060; as ordens de grandeza do README são estimativas, não benchmark.
- Não foi feito estudo perceptual com usuários nem comparação SSIM/ΔE contra fotos reais; o documento descreve o método, não um resultado.
- Alguns links de terceiros (IEEE/DOI, páginas comerciais) podem bloquear bots; a verificação foi feita por status HTTP e conhecimento da fonte, com a ressalva registrada.
- O comportamento exato de `blender-mcp` foi lido no repositório/projeto, mas não executado neste ambiente.

## 13. Referências

Documentação oficial e API:

1. Blender — **Python API Documentation (5.2, current)**: <https://docs.blender.org/api/current/> — visão geral da API, versão corrente.
2. Blender — **Operators (`bpy.ops`)**: <https://docs.blender.org/api/current/bpy.ops.html> — operadores, contexto e poll.
3. Blender — **`bpy.context`**: <https://docs.blender.org/api/current/bpy.context.html> — contexto, `temp_override`, background.
4. Blender — **Depsgraph**: <https://docs.blender.org/api/current/bpy.types.Depsgraph.html> — avaliação de cena, `evaluated_get`.
5. Blender — **ID / custom properties**: <https://docs.blender.org/api/current/bpy.types.ID.html> — ID properties e UI.
6. Blender — **Object**: <https://docs.blender.org/api/current/bpy.types.Object.html> — transformações, modificadores, vínculos.
7. Blender — **`bmesh`**: <https://docs.blender.org/api/current/bmesh.html> — malha programática e operações.

Linha de comando e execução:

8. Blender Manual — **Command Line**: <https://docs.blender.org/manual/en/latest/advanced/command_line/index.html> — execução headless.
9. Blender Manual — **Command Line Arguments**: <https://docs.blender.org/manual/en/latest/advanced/command_line/arguments.html> — `-b`, `-P`, `--python-exit-code`, `--`.
10. Blender — **Release Notes 5.2**: <https://developer.blender.org/docs/release_notes/5.2/> — mudanças da versão alvo.
11. Blender — **5.2 LTS release**: <https://www.blender.org/download/releases/5.2/> — página oficial da release.
12. Blender — **5.2 LTS press release**: <https://www.blender.org/press/blender-5-2-lts-release/> — contexto da release.

Modelagem:

13. Blender Manual — **Mesh primitives**: <https://docs.blender.org/manual/en/latest/modeling/meshes/primitives.html> — primitivas e parâmetros.
14. Blender Manual — **Modifiers**: <https://docs.blender.org/manual/en/latest/modeling/modifiers/index.html> — visão geral e ordem.
15. Blender Manual — **Bevel modifier**: <https://docs.blender.org/manual/en/latest/modeling/modifiers/generate/bevel.html> — largura/segmentos.
16. Blender Manual — **Subdivision Surface**: <https://docs.blender.org/manual/en/latest/modeling/modifiers/generate/subdivision_surface.html> — níveis e render levels.
17. Blender Manual — **Boolean**: <https://docs.blender.org/manual/en/latest/modeling/modifiers/generate/booleans.html> — solver e operações.
18. Blender Manual — **Solidify**: <https://docs.blender.org/manual/en/latest/modeling/modifiers/generate/solidify.html> — espessura.
19. Blender Manual — **Array**: <https://docs.blender.org/manual/en/latest/modeling/modifiers/generate/array.html> — repetição.
20. Blender Manual — **Geometry Nodes**: <https://docs.blender.org/manual/en/latest/modeling/geometry_nodes/index.html> — conceito e campos.
21. Blender Manual — **Distribute Points on Faces**: <https://docs.blender.org/manual/en/latest/modeling/geometry_nodes/point/distribute_points_on_faces.html> — densidade/scatter.
22. Blender Manual — **Instance on Points**: <https://docs.blender.org/manual/en/latest/modeling/geometry_nodes/instances/instance_on_points.html> — instancing.
23. Blender Manual — **Curves**: <https://docs.blender.org/manual/en/latest/modeling/curves/index.html> — curvas, bevel/sweep.

Materiais, UV e texturas:

24. Blender Manual — **Principled BSDF**: <https://docs.blender.org/manual/en/latest/render/shader_nodes/shader/principled.html> — entradas e física.
25. Blender Manual — **UVs**: <https://docs.blender.org/manual/en/latest/modeling/meshes/uv/index.html> — mapeamento e edição.
26. Blender Manual — **UV texture spaces**: <https://docs.blender.org/manual/en/latest/modeling/meshes/uv/uv_texture_spaces.html> — UV maps e projeções.
27. Blender Manual — **Texture nodes**: <https://docs.blender.org/manual/en/latest/render/shader_nodes/textures/index.html> — procedurais e imagens.
28. Blender Manual — **Bump node**: <https://docs.blender.org/manual/en/latest/render/shader_nodes/displacement/bump.html> — relevo procedural.
29. Blender Manual — **Normal Map node**: <https://docs.blender.org/manual/en/latest/render/shader_nodes/displacement/normal_map.html> — normal maps e Non-Color.
30. Poly Haven — **License**: <https://polyhaven.com/license> — CC0 para HDRIs/texturas/modelos.
31. ambientCG — **License**: <https://ambientcg.com/license> — texturas PBR CC0.

Luz, câmera, render:

32. Blender Manual — **Lights**: <https://docs.blender.org/manual/en/latest/render/lights/light_object.html> — tipos, energia, tamanho.
33. Blender Manual — **World**: <https://docs.blender.org/manual/en/latest/render/lights/world.html> — HDRI/background.
34. Blender Manual — **Cameras**: <https://docs.blender.org/manual/en/latest/render/cameras.html> — focal, sensor, DOF.
35. Blender Manual — **Cycles**: <https://docs.blender.org/manual/en/latest/render/cycles/index.html> — path tracing.
36. Blender Manual — **Cycles sampling**: <https://docs.blender.org/manual/en/latest/render/cycles/render_settings/sampling.html> — samples/adaptive.
37. Blender Manual — **Cycles GPU rendering**: <https://docs.blender.org/manual/en/latest/render/cycles/gpu_rendering.html> — OptiX/CUDA.
38. Blender Manual — **Light paths**: <https://docs.blender.org/manual/en/latest/render/cycles/render_settings/light_paths.html> — bounces/caustics.
39. Blender Manual — **Cycles performance**: <https://docs.blender.org/manual/en/latest/render/cycles/render_settings/performance.html> — BVH/memória.
40. Blender Manual — **Color management**: <https://docs.blender.org/manual/en/latest/render/color_management/index.html> — view transform/exposure.
41. Blender — **Release notes 4.0: color management (AgX)**: <https://developer.blender.org/docs/release_notes/4.0/color_management/> — introdução do AgX.
42. Blender Manual — **Output formats**: <https://docs.blender.org/manual/en/latest/render/output/properties/format.html> — PNG/JPEG/EXR/color depth.
43. Blender Manual — **Output**: <https://docs.blender.org/manual/en/latest/render/output/index.html> — resolução, arquivos.
44. Blender Manual — **Eevee**: <https://docs.blender.org/manual/en/latest/render/eevee/index.html> — rasterização e limites.
45. Blender Manual — **Eevee sampling**: <https://docs.blender.org/manual/en/latest/render/eevee/render_settings/sampling.html> — TAA/samples.

Fotorrealismo e métricas:

46. OpenImageDenoise — **site oficial**: <https://openimagedenoise.github.io/> — denoiser CPU/GPU.
47. NVIDIA — **OptiX**: <https://developer.nvidia.com/optix> — ray tracing GPU.
48. **Physically Based Rendering (pbrt)**: <https://pbrt.org/> — referência de light transport/render físico.
49. Wang et al. — **Image Quality Assessment: From Error Visibility to Structural Similarity** (SSIM), IEEE TIP 2004: <https://doi.org/10.1109/TIP.2003.819861> — definição de SSIM (registro DOI; acesso automatizado pode ser bloqueado).
50. Sharma et al. — **The CIEDE2000 Color-Difference Formula**: <https://hajim.rochester.edu/ece/sites/gsharma/ciede2000/> — implementação/valores de ΔE00.
51. Zhang et al. — **The Unreasonable Effectiveness of Deep Features as a Perceptual Metric** (LPIPS): <https://arxiv.org/abs/1801.03924> — métrica perceptual.
52. Sobotka — **Filmic Blender**: <https://github.com/sobotka/filmic-blender> — contexto histórico do view transform.

Automação/MCP:

53. Ahuja — **blender-mcp**: <https://github.com/ahujasid/blender-mcp> — servidor MCP + addon de socket.
54. **Model Context Protocol**: <https://modelcontextprotocol.io/> — especificação e conceitos.
55. **MCP servers (referência)**: <https://github.com/modelcontextprotocol/servers> — implementações e padrões.

> As URLs foram verificadas em 2026-11-04 por requisição HTTP (status 200/301/302) ou por registro de DOI quando o editor bloqueia automação. Alterações de versão do manual podem mudar caminhos; a documentação `current` é a referência viva.
