"""
Package the release downloads into release/:

  browser-agent-server-v<version>.zip        server.mjs + Start scripts (needs only Node)
  browser-agent-extension-v<version>.zip     the full extension, for "Load unpacked"
  browser-agent-chrome-store-v<version>.zip  the Chrome Web Store build (upload this one)

Run `npm run release`, which builds everything first and then calls this.
"""
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RELEASE = ROOT / "release"
EXT = ROOT / "packages" / "extension"


def version() -> str:
    manifest = json.loads((EXT / "static" / "manifest.json").read_text(encoding="utf-8"))
    pkg = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    if manifest["version"] != pkg["version"]:
        raise SystemExit(f"Version mismatch: manifest {manifest['version']} vs package.json {pkg['version']}")
    return pkg["version"]


def add(z: zipfile.ZipFile, src: Path, arc: str, executable: bool = False) -> None:
    info = zipfile.ZipInfo.from_file(src, arc)
    info.compress_type = zipfile.ZIP_DEFLATED
    # Unix permissions so start.sh is runnable after unzipping on macOS/Linux.
    info.external_attr = (0o755 if executable else 0o644) << 16
    z.writestr(info, src.read_bytes())


def zip_dir(src: Path, out: Path, prefix: str = "") -> None:
    if not (src / "manifest.json").exists():
        raise SystemExit(f"{src} has no manifest.json: build it first")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(src.rglob("*")):
            if f.is_file() and not f.name.endswith(".map"):
                add(z, f, prefix + f.relative_to(src).as_posix())


def main() -> None:
    v = version()
    server = RELEASE / "server"
    if not (server / "server.mjs").exists():
        raise SystemExit("release/server/server.mjs is missing: run `npx tsx scripts/build-server.ts` first")
    files = ROOT / "scripts" / "release-files"
    out = RELEASE / f"browser-agent-server-v{v}.zip"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        base = "browser-agent-server/"
        for f in sorted(server.iterdir()):
            if f.is_file():
                add(z, f, base + f.name)
        for f in sorted(files.iterdir()):
            add(z, f, base + f.name, executable=f.name.endswith(".sh"))
    print(out.name, out.stat().st_size // 1024, "KB")

    for src, name in ((EXT / "dist", "extension"), (EXT / "dist-store", "chrome-store")):
        out = RELEASE / f"browser-agent-{name}-v{v}.zip"
        zip_dir(src, out)
        print(out.name, out.stat().st_size // 1024, "KB")


if __name__ == "__main__":
    main()
