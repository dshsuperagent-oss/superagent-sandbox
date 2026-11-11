# Leitura de PNG sem PIL

## Titulo
Decodificar PNG 8 bits (RGB/RGBA/cinza) so com stdlib (zlib + struct).

## Contexto
O avaliador garante numpy, mas PIL e "se disponivel". Um programa que so
funciona com PIL pode falhar num ambiente minimo. Precisamos de um fallback
pequeno e correto.

## Regra/tecnica
- PNG = assinatura de 8 bytes + chunks (`length`, `type`, `data`, `crc`).
  Junte os `IDAT`, `zlib.decompress`.
- O fluxo descomprimido e uma sequencia de linhas, cada uma com 1 byte de
  filtro (0 None, 1 Sub, 2 Up, 3 Average, 4 Paeth) seguida dos bytes.
- Desfiltre por linha usando a linha anterior; para Sub/Average/Paeth o
  "vizinho da esquerda" depende de `nch` (1, 2, 3 ou 4 canais).
- Paeth: `p = a+b-c`; escolha o mais proximo entre `a`, `b`, `c` por
  `|p-a|, |p-b|, |p-c|` (empate -> a, depois b).
- Suporte so a 8 bits, sem interlace; recuse o resto com erro claro. Converta
  RGBA/cinza para RGB.
- Prefira PIL quando existir (mais rapido/robusto); o fallback e para
  sobrevivencia, nao para producao pesada.

## Evidencia
- Nosso `_png_read_stdlib` le `ref-A1.png` (256x256 RGB) e um RGBA 256x256
  sem diferenca visual; o pipeline roda igual com e sem PIL.
- Em teste limpo (copia so da solucao, sem PIL no caminho do import), o CLI
  continua gerando cena valida.
- A leitura leva ~5 ms para 256x256; nao e gargalo.

## Quando reutilizar
- CLIs que precisam rodar em containers minimos/sem Pillow.
- Ferramentas de build que so podem usar stdlib.
- Entender por que uma imagem "abre torta" (filtro/Paeth implementado errado).
