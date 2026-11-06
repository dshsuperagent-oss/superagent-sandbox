# Indice de conhecimento — Desafio da Sala Cega

Conhecimento reutilizavel aprendido construindo o `reconstruir.py`. Cada
entrada segue o formato pedido: **titulo**, **contexto**, **regra/tecnica**,
**evidencia** (numero/teste/imagem) e **quando reutilizar** (fora deste
desafio). O indice abaixo e a porta de entrada.

| Titulo | Quando usar | Link |
|---|---|---|
| Camera pinhole e projecao | Precisar converter pixel <-> raio/mundo, validar FOV e lente | [geometria/camera-pinhole-e-projecao.md](geometria/camera-pinhole-e-projecao.md) |
| Homografia de um retangulo | Medir proporcao/pose de um retangulo plano (janela, quadro, tela) | [geometria/homografia-de-retangulo.md](geometria/homografia-de-retangulo.md) |
| Pontos de fuga e rotacao | Recuperar rotacao da camera e focal a partir de retas da cena | [geometria/pontos-de-fuga-e-rotacao.md](geometria/pontos-de-fuga-e-rotacao.md) |
| Reconstrucao da parede do fundo | Obter altura de teto, peitoril e largura a partir de raios | [geometria/reconstrucao-parede-do-fundo.md](geometria/reconstrucao-parede-do-fundo.md) |
| Plano de piso e mobiliario | Mapear mascaras 2D para o piso/paredes e medir moveis | [geometria/plano-de-piso-e-mobiliario.md](geometria/plano-de-piso-e-mobiliario.md) |
| Mascaras de cor e componentes | Segmentar objetos por cor e escolher a componente principal | [programacao/mascaras-de-cor-e-componentes.md](programacao/mascaras-de-cor-e-componentes.md) |
| Otimizacao sem scipy | Refinar parametros com Nelder-Mead em numpy puro | [programacao/otimizacao-sem-scipy.md](programacao/otimizacao-sem-scipy.md) |
| Metricas de similaridade | Medir MAE/bordas/SSIM e comparar renders | [programacao/metricas-de-similaridade.md](programacao/metricas-de-similaridade.md) |
| Desempenho e determinismo | Garantir bytes identicos e orcamento de tempo | [programacao/desempenho-e-determinismo.md](programacao/desempenho-e-determinismo.md) |
| Leitura de PNG sem PIL | Rodar em ambiente minimo (stdlib + numpy) | [programacao/leitura-de-png-sem-pil.md](programacao/leitura-de-png-sem-pil.md) |
| Semantica do builder | Entender exatamente como cena.json vira render | [blender/semantica-do-builder.md](blender/semantica-do-builder.md) |
| AgX e cor de material | Calibrar cor base a partir de um render AgX | [blender/agx-e-cores-de-material.md](blender/agx-e-cores-de-material.md) |
| Luzes e rig de iluminacao | Montar/otimizar sol, area, ambiente e emitter | [blender/luzes-e-rig.md](blender/luzes-e-rig.md) |
| Armadilhas do kit | Evitar erros de espessura, plano, exposicao e denoise | [blender/armadilhas.md](blender/armadilhas.md) |
| Calibrar com o exemplo | Validar um renderizador/copia do builder contra o kit | [processos/calibrar-com-o-exemplo.md](processos/calibrar-com-o-exemplo.md) |
| Comparar e medir renders | Fechar o ciclo "olhar -> numero -> decisao" | [processos/comparar-e-medir-renders.md](processos/comparar-e-medir-renders.md) |
| Dataset sintetico e validacao | Testar generalizacao sem tocar na cena reservada | [processos/dataset-sintetico-e-validacao.md](processos/dataset-sintetico-e-validacao.md) |
| Reconstrucao em etapas | Ordem de implementacao/depuracao de um pipeline inverso | [processos/reconstrucao-em-etapas.md](processos/reconstrucao-em-etapas.md) |
