# side-by-side: reference (left) vs build (right). usage: python compose.py refdir builddir outdir
import sys, os
from PIL import Image, ImageDraw
ref, build, out = sys.argv[1:4]
for f in sorted(os.listdir(build)):
    if not f.endswith('.png'): continue
    a = Image.open(os.path.join(ref, f)).convert('RGB'); b = Image.open(os.path.join(build, f)).convert('RGB')
    W = 1300
    a = a.resize((W, round(a.height * W / a.width))); b = b.resize((W, round(b.height * W / b.width)))
    H = max(a.height, b.height)
    c = Image.new('RGB', (W * 2 + 20, H + 40), 'white'); d = ImageDraw.Draw(c)
    c.paste(a, (0, 40)); c.paste(b, (W + 20, 40))
    d.text((10, 10), 'REFERENCE ' + f, fill='black'); d.text((W + 30, 10), 'BUILD ' + f, fill='black')
    c.save(os.path.join(out, f.replace('.png', '_cmp.png')))
    print(f)
