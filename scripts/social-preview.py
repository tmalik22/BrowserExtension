"""Build docs/screenshots/social-preview.png (1280x640) for GitHub's social preview setting."""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

SHOTS = Path(__file__).resolve().parent.parent / "docs" / "screenshots"


def font(size, bold=False):
    names = ["segoeuib.ttf", "Arial Bold.ttf", "DejaVuSans-Bold.ttf"] if bold else ["segoeui.ttf", "Arial.ttf", "DejaVuSans.ttf"]
    for n in names:
        try:
            return ImageFont.truetype(n, size)
        except OSError:
            pass
    return ImageFont.load_default()


W, H = 1280, 640
bg = Image.new("RGB", (W, H))
d = ImageDraw.Draw(bg)
for y in range(H):
    t = y / H
    d.line([0, y, W, y], fill=(int(11 + 20 * t), int(15 + 26 * t), int(23 + 32 * t)))

# App window (hero without its own background), tilted into the right side.
hero = Image.open(SHOTS / "hero.png").convert("RGB")
win = hero.crop((48, 48, hero.width - 48, hero.height - 48))
scale = 700 / win.width
win = win.resize((700, int(win.height * scale)), Image.LANCZOS)
x, y = W - win.width - 40, (H - win.height) // 2 + 20
shadow = Image.new("L", (W, H), 0)
ImageDraw.Draw(shadow).rounded_rectangle([x, y + 12, x + win.width, y + win.height + 12], radius=12, fill=170)
bg.paste(Image.new("RGB", (W, H), "#000"), (0, 0), shadow.filter(ImageFilter.GaussianBlur(20)))
mask = Image.new("L", win.size, 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, win.width - 1, win.height - 1], radius=12, fill=255)
bg.paste(win, (x, y), mask)

d = ImageDraw.Draw(bg)
logo = Image.open(SHOTS.parent / "brand" / "logo-512.png").convert("RGBA").resize((76, 76), Image.LANCZOS)
bg.paste(logo, (56, 66), logo)
d.text((56, 150), "Browser Agent", font=font(64, True), fill="#ffffff")
d.text((58, 238), "AI that drives your Chrome,", font=font(30), fill="#e5e7eb")
d.text((58, 278), "with any model you want.", font=font(30), fill="#b7f34a")
chips = ["Local & self-hosted", "Abliterated OK", "Approval switches", "CAPTCHA helper"]
cx, cy = 58, 350
for c in chips:
    f = font(20, True)
    l, t, r, b = d.textbbox((0, 0), c, font=f)
    if cx + (r - l) + 28 > 520:
        cx, cy = 58, cy + 52
    d.rounded_rectangle([cx, cy, cx + (r - l) + 28, cy + 40], radius=20, fill="#1f2937", outline="#b7f34a", width=2)
    d.text((cx + 14 - l, cy + 20 - (b + t) // 2), c, font=f, fill="#b7f34a")
    cx += (r - l) + 40
d.text((58, 540), "Open source · MIT · github.com/tmalik22/BrowserExtension", font=font(18), fill="#9ca3af")
out = SHOTS / "social-preview.png"
bg.save(out, optimize=True)
print(out, bg.size, out.stat().st_size // 1024, "KB")
