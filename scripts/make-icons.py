"""
Render the Browser Agent logo (midnight tile + lime navigation arrow) to every size we ship:

  packages/extension/static/icons/{16,32,48,128}.png   extension icons
  docs/brand/logo.svg, logo-512.png                      README / social use
  docs/brand/store-icon-128.png                          Chrome Web Store icon (96px art + 16px padding)

    python scripts/make-icons.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
MIDNIGHT = "#111827"
LIME = "#B7F34A"
# Arrow on a 128-unit canvas. Small sizes use a chunkier arrow so it stays readable.
ARROW = [(100, 28), (66, 104), (58, 70), (24, 62)]
ARROW_SMALL = [(106, 22), (66, 110), (56, 72), (18, 62)]
RADIUS = 28


def tile(size: int, arrow, pad: int = 0) -> Image.Image:
    """Draw at 8x and downsample for smooth edges. `pad` = transparent margin in output px."""
    ss = 8
    inner = size - 2 * pad
    big = Image.new("RGBA", (size * ss, size * ss), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    k = inner * ss / 128
    o = pad * ss
    d.rounded_rectangle([o, o, o + inner * ss - 1, o + inner * ss - 1], radius=RADIUS * k, fill=MIDNIGHT)
    d.polygon([(o + x * k, o + y * k) for x, y in arrow], fill=LIME)
    return big.resize((size, size), Image.LANCZOS)


def main() -> None:
    icons = ROOT / "packages" / "extension" / "static" / "icons"
    brand = ROOT / "docs" / "brand"
    icons.mkdir(parents=True, exist_ok=True)
    brand.mkdir(parents=True, exist_ok=True)
    for s in (16, 32, 48, 128):
        tile(s, ARROW_SMALL if s <= 32 else ARROW).save(icons / f"{s}.png", optimize=True)
    tile(512, ARROW).save(brand / "logo-512.png", optimize=True)
    tile(128, ARROW, pad=16).save(brand / "store-icon-128.png", optimize=True)
    pts = " ".join(f"{x},{y}" for x, y in ARROW)
    (brand / "logo.svg").write_text(
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-label="Browser Agent">'
        f'<rect width="128" height="128" rx="{RADIUS}" fill="{MIDNIGHT}"/><polygon points="{pts}" fill="{LIME}"/></svg>\n',
        encoding="utf-8",
    )
    print("icons written")


if __name__ == "__main__":
    main()
