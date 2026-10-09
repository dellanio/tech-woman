"""Gera as variantes web da arte Perfil 1 (Contorno).

Le o PNG transparente mestre e grava em public/arte/:
  perfil-1.webp / perfil-1.png          (tema escuro, so redimensionado)
  perfil-1-claro.webp / perfil-1-claro.png (linhas recoloridas vinho/vermelho para fundo claro)
Uso: python3 scripts/gerar-perfil-claro.py   (requer Pillow)
"""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT.parent / '20-spec' / 'design' / 'perfil' / 'perfil-1.png'
OUT = ROOT / 'public' / 'arte'
SIDE = 1400
WINE = (143, 24, 49)
RED = (204, 9, 47)

def recolor(img):
    px = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            ratio = max(0.0, min(1.0, (r - g) / max(r, 1)))
            mix = max(0.0, min(1.0, (ratio - 0.45) / 0.5))
            px[x, y] = tuple(round(WINE[i] * (1 - mix) + RED[i] * mix) for i in range(3)) + (a,)
    return img

OUT.mkdir(parents=True, exist_ok=True)
base = Image.open(SRC).convert('RGBA').resize((SIDE, SIDE), Image.Resampling.LANCZOS)
for name, im in (('perfil-1', base), ('perfil-1-claro', recolor(base.copy()))):
    im.save(OUT / f'{name}.webp', 'WEBP', quality=86, method=6, alpha_quality=95)
    im.save(OUT / f'{name}.png', optimize=True)
    print(name, (OUT / f'{name}.webp').stat().st_size, (OUT / f'{name}.png').stat().st_size)
