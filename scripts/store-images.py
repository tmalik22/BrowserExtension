"""
Chrome Web Store images from the raw README captures (run readme-shots first):

  store/screenshot-{1..5}.png   1280x800 screenshots
  store/promo-small.png         440x280 small promo tile
  store/promo-marquee.png       1400x560 marquee promo tile
  store/icon-128.png            128x128 store icon (96px art + transparent padding)

    python scripts/store-images.py
"""
from pathlib import Path
import shutil

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "docs" / "screenshots" / "raw"
SHOTS = ROOT / "docs" / "screenshots"
BRAND = ROOT / "docs" / "brand"
OUT = ROOT / "store"
LIME = "#b7f34a"


def font(size, bold=False):
    for n in (["segoeuib.ttf", "Arial Bold.ttf", "DejaVuSans-Bold.ttf"] if bold else ["segoeui.ttf", "Arial.ttf", "DejaVuSans.ttf"]):
        try:
            return ImageFont.truetype(n, size)
        except OSError:
            pass
    return ImageFont.load_default()


def gradient(w, h):
    bg = Image.new("RGB", (w, h))
    d = ImageDraw.Draw(bg)
    for y in range(h):
        t = y / h
        d.line([0, y, w, y], fill=(int(11 + 20 * t), int(15 + 26 * t), int(23 + 32 * t)))
    return bg


def window(page, panel, url):
    bar = 40
    h = max(page.height, panel.height)
    w = page.width + panel.width + 1
    win = Image.new("RGB", (w, h + bar), "#ffffff")
    d = ImageDraw.Draw(win)
    d.rectangle([0, 0, w, bar], fill="#ececec")
    for i, c in enumerate(["#ff5f57", "#febc2e", "#28c840"]):
        d.ellipse([14 + i * 20, 14, 26 + i * 20, 26], fill=c)
    d.rounded_rectangle([86, 8, page.width - 20, bar - 8], radius=11, fill="#ffffff")
    d.text((102, 11), url, fill="#555555", font=font(14))
    win.paste(page, (0, bar))
    d.line([page.width, bar, page.width, h + bar], fill="#d0d0d0")
    win.paste(panel, (page.width + 1, bar))
    return win


def place(canvas, img, box):
    """Fit img into box (x, y, w, h) keeping aspect, with rounded corners and a shadow."""
    x, y, bw, bh = box
    k = min(bw / img.width, bh / img.height)
    img = img.resize((int(img.width * k), int(img.height * k)), Image.LANCZOS)
    px, py = x + (bw - img.width) // 2, y + (bh - img.height) // 2
    sh = Image.new("L", canvas.size, 0)
    ImageDraw.Draw(sh).rounded_rectangle([px, py + 8, px + img.width, py + img.height + 8], radius=12, fill=160)
    canvas.paste(Image.new("RGB", canvas.size, "#000"), (0, 0), sh.filter(ImageFilter.GaussianBlur(16)))
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, img.width - 1, img.height - 1], radius=12, fill=255)
    canvas.paste(img, (px, py), mask)


def screenshot(name, url, title, subtitle, out):
    c = gradient(1280, 800)
    d = ImageDraw.Draw(c)
    d.text((64, 40), title, font=font(40, True), fill="#ffffff")
    d.text((66, 96), subtitle, font=font(22), fill=LIME)
    page = Image.open(RAW / f"{name}-page.png").convert("RGB")
    panel = Image.open(RAW / f"{name}-panel.png").convert("RGB")
    place(c, window(page, panel, url), (48, 150, 1184, 620))
    c.save(out, optimize=True)


def panel_shot(img_name, title, subtitle, out):
    c = gradient(1280, 800)
    d = ImageDraw.Draw(c)
    d.text((64, 300), title, font=font(40, True), fill="#ffffff")
    y = 360
    for line in subtitle:
        d.text((66, y), line, font=font(22), fill="#d1d5db")
        y += 34
    place(c, Image.open(SHOTS / img_name).convert("RGB"), (700, 40, 520, 720))
    c.save(out, optimize=True)


def promo(w, h, out, tagline=True):
    c = gradient(w, h)
    d = ImageDraw.Draw(c)
    s = int(h * 0.42)
    logo = Image.open(BRAND / "logo-512.png").convert("RGBA").resize((s, s), Image.LANCZOS)
    c.paste(logo, (int(h * 0.12), (h - s) // 2), logo)
    x = int(h * 0.12) + s + int(h * 0.08)
    room = w - x - int(h * 0.1)

    def fit(text, size, bold=False):
        while size > 8 and d.textlength(text, font=font(size, bold)) > room:
            size -= 1
        return font(size, bold)

    d.text((x, int(h * 0.30)), "Browser Agent", font=fit("Browser Agent", int(h * 0.15), True), fill="#ffffff")
    if tagline:
        sub = min(int(h * 0.075), fit("Your AI agent in Chrome.", int(h * 0.075)).size)
        d.text((x + 2, int(h * 0.52)), "Your AI agent in Chrome.", font=font(sub), fill="#e5e7eb")
        d.text((x + 2, int(h * 0.64)), "Any model, even local.", font=font(sub), fill=LIME)
    c.save(out, optimize=True)


def main():
    OUT.mkdir(exist_ok=True)
    screenshot("flow-2", "kilnandco.example/shop", "It stops before anything that matters", "Purchases, logins, sending, deleting: you approve. Every step visible.", OUT / "screenshot-1.png")
    screenshot("flow-3", "kilnandco.example/shop", "Tell it what you want, in plain English", "It clicks, types and fills forms in your real browser, then reports back.", OUT / "screenshot-2.png")
    screenshot("captcha", "kilnandco.example/verify", "Gets past CAPTCHA checks (optional)", "A vision model you pick clears the challenge, then the task carries on.", OUT / "screenshot-3.png")
    panel_shot("panel-settings.png", "You decide what needs approval", ["Eleven separate switches:", "payments, logins, passwords, sending,", "deleting, account changes and more.", "All on by default."], OUT / "screenshot-4.png")
    panel_shot("panel-gpu.png", "Use any model, even a local one", ["Ollama, LM Studio, vLLM, llama.cpp", "or your own cloud API keys.", "Built-in GPU monitor for local models.", "No account. No telemetry."], OUT / "screenshot-5.png")
    promo(440, 280, OUT / "promo-small.png")
    promo(1400, 560, OUT / "promo-marquee.png")
    shutil.copyfile(BRAND / "store-icon-128.png", OUT / "icon-128.png")
    for f in sorted(OUT.glob("*.png")):
        with Image.open(f) as im:
            print(f.name, im.size)


if __name__ == "__main__":
    main()
