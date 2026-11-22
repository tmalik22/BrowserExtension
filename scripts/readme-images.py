"""
Compose the README images from the raw captures made by e2e/tests/readme-shots.spec.ts.

    SHOTS=1 npx playwright test -c e2e/playwright.config.ts readme-shots
    python scripts/readme-images.py

Needs Pillow (pip install pillow). Writes docs/screenshots/hero.png, demo.gif and captcha.png.
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

SHOTS = Path(__file__).resolve().parent.parent / "docs" / "screenshots"
RAW = SHOTS / "raw"


def font(size: int) -> ImageFont.ImageFont:
    for name in ("segoeui.ttf", "SegoeUI.ttf", "Arial.ttf", "DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def window(page: Image.Image, panel: Image.Image, url: str) -> Image.Image:
    """A browser window: tab strip + address bar, the page, and the side panel on the right."""
    bar = 44
    h = max(page.height, panel.height)
    w = page.width + panel.width + 1
    win = Image.new("RGB", (w, h + bar), "#ffffff")
    d = ImageDraw.Draw(win)
    d.rectangle([0, 0, w, bar], fill="#ececec")
    for i, c in enumerate(["#ff5f57", "#febc2e", "#28c840"]):
        d.ellipse([16 + i * 22, 16, 28 + i * 22, 28], fill=c)
    d.rounded_rectangle([96, 9, page.width - 20, bar - 9], radius=12, fill="#ffffff")
    d.text((114, 13), url, fill="#555555", font=font(15))
    win.paste(page, (0, bar))
    d.line([page.width, bar, page.width, h + bar], fill="#d0d0d0")
    win.paste(panel, (page.width + 1, bar))
    return win


def framed(win: Image.Image, pad: int = 48) -> Image.Image:
    """Rounded window with a soft shadow on a dusk gradient."""
    bg = Image.new("RGB", (win.width + pad * 2, win.height + pad * 2))
    gd = ImageDraw.Draw(bg)
    for y in range(bg.height):
        t = y / bg.height
        gd.line([0, y, bg.width, y], fill=(int(40 + 60 * t), int(30 + 25 * t), int(70 - 10 * t)))
    shadow = Image.new("L", bg.size, 0)
    ImageDraw.Draw(shadow).rounded_rectangle([pad, pad + 10, pad + win.width, pad + win.height + 10], radius=14, fill=150)
    bg.paste(Image.new("RGB", bg.size, "#000000"), (0, 0), shadow.filter(ImageFilter.GaussianBlur(18)))
    mask = Image.new("L", win.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, win.width - 1, win.height - 1], radius=14, fill=255)
    bg.paste(win, (pad, pad), mask)
    return bg


def caption(img: Image.Image, text: str) -> Image.Image:
    """Extend the canvas downwards and put a centred pill caption under the window (GIF frames)."""
    extra = 84
    out = Image.new("RGB", (img.width, img.height + extra), img.getpixel((0, img.height - 1)))
    out.paste(img, (0, 0))
    d = ImageDraw.Draw(out)
    f = font(28)
    l, t, r, b = d.textbbox((0, 0), text, font=f)
    tw, th = r - l, b - t
    x = (out.width - tw) // 2
    y = img.height - 18 + (extra - th) // 2
    d.rounded_rectangle([x - 22, y - 14, x + tw + 22, y + th + 16], radius=24, fill="#c0623b")
    d.text((x - l, y - t), text, fill="#ffffff", font=f)
    return out


def pair(name: str, url: str) -> Image.Image:
    page = Image.open(RAW / f"{name}-page.png").convert("RGB")
    panel = Image.open(RAW / f"{name}-panel.png").convert("RGB")
    return framed(window(page, panel, url))


def main() -> None:
    hero = pair("flow-2", "kilnandco.example/shop")
    hero.save(SHOTS / "hero.png", optimize=True)

    steps = [
        ("flow-1", "1  You ask, in plain English", 1800),
        ("flow-2", "2  It works the page, and stops before paying", 2600),
        ("flow-3", "3  You approve, it finishes and reports back", 3200),
    ]
    frames, durations = [], []
    for name, text, ms in steps:
        img = caption(pair(name, "kilnandco.example/shop"), text)
        img = img.resize((img.width * 2 // 3, img.height * 2 // 3), Image.LANCZOS)
        frames.append(img.quantize(colors=200, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE))
        durations.append(ms)
    frames[0].save(SHOTS / "demo.gif", save_all=True, append_images=frames[1:], duration=durations, loop=0, optimize=True)

    pair("captcha", "kilnandco.example/verify").save(SHOTS / "captcha.png", optimize=True)
    for f in ("hero.png", "demo.gif", "captcha.png"):
        print(f, (SHOTS / f).stat().st_size // 1024, "KB")


if __name__ == "__main__":
    main()
