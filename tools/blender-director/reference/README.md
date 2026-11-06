# Imagem de referência

- **Arquivo:** `living-room.png` (1280×854), convertido do JPEG original
  `source.jpg` (mesmo enquadramento; o PNG existe porque o `evaluate.py` lê
  PNG sem dependências externas).
- **Título:** *Modern living room with stylish furniture and a view of the
  outdoors in a cozy apartment setting*
- **Autor:** Shixart1985 (Wikimedia Commons)
- **Origem:** https://commons.wikimedia.org/wiki/File:Modern_living_room_with_stylish_furniture_and_a_view_of_the_outdoors_in_a_cozy_apartment_setting.jpg
- **Licença:** CC BY 2.0 — https://creativecommons.org/licenses/by/2.0/
- **Mudanças:** redimensionada para 1280×854 e convertida de JPEG para PNG.

A foto é usada apenas como referência de composição/iluminação para o
`examples/room-living.json` e para o relatório de comparação. O render não
reproduz a foto pixel a pixel: o objetivo é medir aderência de enquadramento,
cor e luz com métricas explícitas (`SSIM`, `ΔE00`, histograma e, quando houver
máscaras, IoU de silhueta).
