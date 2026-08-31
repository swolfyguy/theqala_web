#!/usr/bin/env python3
"""
Scan photos/ and write photos/catalogue.json.

FILENAMES DO NOT MATTER. Drop photographs straight off your phone into the
right folder and this gives each one a number.

    photos/<category>/<low>-<high>/anything.jpg      one piece
    photos/<category>/<low>-<high>/<any folder>/     one piece, several views

Any image format works — jpg, jpeg, png, webp, avif, gif, svg are used as they
are; heic, heif, tif, tiff and bmp are converted to jpg automatically (needs
`pip install pillow pillow-heif`).
    photos/<category>/anything.jpg                   the category tile
    photos/hero.mp4  photos/hero-1.jpg               the home page

So:

    photos/rajwadi/2000-3000/IMG_4432.jpg            -> RAJWADI-2000-1
    photos/rajwadi/2000-3000/WhatsApp Image 3.jpg    -> RAJWADI-2000-2
    photos/rajwadi/2000-3000/necklace-shoot/         -> RAJWADI-2000-3
        IMG_5501.jpg  IMG_5502.jpg  IMG_5503.jpg        (all views of that one piece)

Numbers are handed out in filename order the first time a file is seen, and
then they STAY. Adding a photo that sorts before the others does not renumber
anything — a customer who saved RAJWADI-2000-3 still gets the same piece a year
later. Numbers of deleted pieces are retired, never handed out again.

Run it yourself with `python3 build_catalogue.py`, or let the GitHub Action
run it on every push.

    python3 build_catalogue.py --optimize

also shrinks any oversized photo in place (max 1400px wide) before building, so
you never have to resize anything by hand. Do that before committing — big
photographs bloat the repository as well as the site.
"""

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PHOTOS = ROOT / "photos"
OUT = PHOTOS / "catalogue.json"

# What a browser can put on a page as-is.
WEB_EXT = {".jpg", ".jpeg", ".jpe", ".jfif", ".png", ".webp", ".avif", ".gif", ".svg"}
# Real image files that browsers cannot show — converted to .jpg automatically.
CONVERT_EXT = {".heic", ".heif", ".tif", ".tiff", ".bmp", ".dib", ".ico", ".ppm", ".tga"}
IMAGE_EXT = WEB_EXT | CONVERT_EXT
VIDEO_EXT = {".mp4", ".webm", ".mov", ".m4v", ".ogv"}

BIG_FILE = 400_000          # warn above this many bytes
MAX_WIDTH = 1400            # --optimize shrinks anything wider than this
OPTIMIZE = False            # set by the --optimize flag
_pillow = None              # None = not tried yet, False = unavailable


def pillow():
    """Pillow, plus HEIC support if pillow-heif is installed. Loaded on demand."""
    global _pillow
    if _pillow is None:
        try:
            from PIL import Image
            try:
                import pillow_heif
                pillow_heif.register_heif_opener()
            except Exception:
                pass
            _pillow = Image
        except Exception:
            _pillow = False
    return _pillow


def optimize(path):
    """--optimize only: shrink an oversized photo in place. Never touches SVG."""
    if path.suffix.lower() == ".svg":
        return
    Image = pillow()
    if not Image:
        warn("--optimize needs Pillow (pip install pillow)")
        return
    try:
        before = path.stat().st_size
        with Image.open(path) as im:
            wide = im.width > MAX_WIDTH
            if not wide and before <= BIG_FILE:
                return
            if wide:
                im = im.copy()
                im.thumbnail((MAX_WIDTH, MAX_WIDTH * 4), Image.LANCZOS)
            if path.suffix.lower() in {".png", ".webp", ".gif", ".avif"} and im.mode in ("RGBA", "P", "LA"):
                im.save(path, optimize=True)          # keep transparency, keep the format
            else:
                if im.mode not in ("RGB", "L"):
                    im = im.convert("RGB")
                im.save(path, "JPEG" if path.suffix.lower() in {".jpg", ".jpeg", ".jpe", ".jfif"}
                        else None, quality=82, optimize=True, progressive=True)
        after = path.stat().st_size
        if after < before:
            print(f"  optimised {rel(path)}  {before/1000:.0f} KB -> {after/1000:.0f} KB")
    except Exception as e:
        warn(f"could not optimise {rel(path)}: {e}")


def to_jpeg(src):
    """Write a .jpg beside a format browsers cannot display. Returns the new path or None."""
    dest = src.with_suffix(".jpg")
    if dest.exists():
        return dest
    Image = pillow()
    if not Image:
        warn(f"{rel(src)} is a {src.suffix.lower()[1:]} file, which browsers cannot show, and "
             f"Pillow is not installed to convert it — skipped (pip install pillow pillow-heif)")
        return None
    try:
        with Image.open(src) as im:
            if im.mode not in ("RGB", "L"):
                im = im.convert("RGB")
            im.save(dest, "JPEG", quality=88, optimize=True, progressive=True)
        print(f"  converted {rel(src)} -> {rel(dest)}")
        return dest
    except Exception as e:
        warn(f"could not convert {rel(src)}: {e}")
        return None
BAND_RE = re.compile(r"^(\d+)\s*[-–_ ]\s*(\d+)$")

warnings = []


def warn(msg):
    warnings.append(msg)


def rel(path):
    return path.relative_to(ROOT).as_posix()


def natural(name):
    """Sort IMG_2 before IMG_10, and case-insensitively."""
    return [int(p) if p.isdigit() else p.lower() for p in re.split(r"(\d+)", name)]


def images_in(folder):
    """Every image in a folder, with unshowable formats converted to .jpg first."""
    out = []
    for f in sorted((f for f in folder.iterdir() if f.is_file()), key=lambda f: natural(f.name)):
        ext = f.suffix.lower()
        if ext in WEB_EXT:
            out.append(f)
        elif ext in CONVERT_EXT:
            converted = to_jpeg(f)
            if converted:
                out.append(converted)
        else:
            continue
    # a converted file and its original share a stem; keep one entry per file, deduped
    seen, uniq = set(), []
    for f in out:
        if f not in seen:
            seen.add(f)
            uniq.append(f)
    for f in uniq:
        if OPTIMIZE:
            optimize(f)
        if f.stat().st_size > BIG_FILE:
            warn(f"{rel(f)} is {f.stat().st_size/1_000_000:.1f} MB — run "
                 f"`python3 build_catalogue.py --optimize` to shrink it, or the shop will "
                 f"crawl on mobile data")
    return sorted(uniq, key=lambda f: natural(f.name))


def load_previous():
    """Remember which key already owns which number, so codes never move."""
    assigned, nxt = {}, {}
    try:
        old = json.loads(OUT.read_text(encoding="utf-8"))
    except Exception:
        return assigned, nxt
    for cat in old.get("categories", []):
        for band in cat.get("bands", []):
            slot = (cat.get("slug"), band.get("min"), band.get("max"))
            known = {}
            for it in band.get("items", []):
                if "key" not in it:
                    continue
                key = it["key"]
                known[key] = it["n"]
                if not key.endswith("/") and "." in key:     # older filename-based key
                    known.setdefault(key.rsplit(".", 1)[0], it["n"])
            assigned[slot] = known
            nxt[slot] = band.get("next") or (max([it["n"] for it in band.get("items", [])] or [0]) + 1)
    return assigned, nxt


def read_band(banddir, slot, assigned, nxt):
    """Every loose image is a piece; every subfolder is one piece with several views."""
    pieces = []          # (key, [files])
    for sub in sorted((d for d in banddir.iterdir() if d.is_dir()), key=lambda d: natural(d.name)):
        views = images_in(sub)
        if views:
            pieces.append((sub.name + "/", [rel(f) for f in views]))
        else:
            warn(f"no images in {rel(sub)} — skipped")
    by_stem = {}
    for f in images_in(banddir):
        by_stem.setdefault(f.stem, []).append(rel(f))
    for stem in sorted(by_stem, key=natural):
        pieces.append((stem, by_stem[stem]))

    for f in banddir.iterdir():
        if f.is_file() and f.suffix.lower() not in IMAGE_EXT and not f.name.startswith("."):
            warn(f"not an image, ignored: {rel(f)}")

    known = assigned.setdefault(slot, {})
    counter = nxt.get(slot, 1)
    items = []
    for key, files in pieces:
        if key in known:
            n = known[key]
        else:
            n = counter
            counter += 1
            known[key] = n
        items.append({"n": n, "key": key, "files": files})
    nxt[slot] = counter
    items.sort(key=lambda i: i["n"])
    return items


def find_hero():
    hero = {"image": None, "video": None}
    for f in sorted(PHOTOS.iterdir(), key=lambda p: natural(p.name)):
        if not f.is_file() or not f.stem.lower().startswith("hero"):
            continue
        if f.suffix.lower() in IMAGE_EXT and hero["image"] is None:
            hero["image"] = rel(f)
        elif f.suffix.lower() in VIDEO_EXT and hero["video"] is None:
            hero["video"] = rel(f)
    return hero


def main():
    if not PHOTOS.is_dir():
        print(f"no photos/ folder at {PHOTOS}", file=sys.stderr)
        return 1

    assigned, nxt = load_previous()
    categories = []
    total_pieces = total_files = 0

    for catdir in sorted((p for p in PHOTOS.iterdir() if p.is_dir()), key=lambda d: natural(d.name)):
        slug = catdir.name
        banddirs = []
        for d in (p for p in catdir.iterdir() if p.is_dir()):
            m = BAND_RE.match(d.name.strip())
            if not m:
                warn(f"folder name should look like 2000-3000 — ignored: {rel(d)}")
                continue
            low, high = int(m.group(1)), int(m.group(2))
            if high <= low:
                warn(f"price folder reads backwards, ignored: {rel(d)}")
                continue
            banddirs.append((low, high, d))
        banddirs.sort(key=lambda t: t[0])

        bands = []
        for low, high, d in banddirs:
            slot = (slug, low, high)
            items = read_band(d, slot, assigned, nxt)
            if not items:
                continue
            for it in items:
                it["code"] = f"{slug.upper()}-{low}-{it['n']}"
                total_files += len(it["files"])
            total_pieces += len(items)
            bands.append({"min": low, "max": high, "next": nxt[slot], "items": items})

        covers = images_in(catdir)
        cover = rel(covers[0]) if covers else None
        if bands or cover:
            categories.append({"slug": slug, "cover": cover, "bands": bands})

    data = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "hero": find_hero(),
        "categories": categories,
    }
    OUT.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")

    print(f"{OUT.relative_to(ROOT)}: {total_pieces} pieces, {total_files} photos, "
          f"{len(categories)} categories")
    for c in categories:
        line = ", ".join(f"{b['min']}-{b['max']}: {len(b['items'])}" for b in c["bands"])
        print(f"  {c['slug']:<20} {line or '(no pieces yet)'}")
    if warnings:
        print(f"\n{len(warnings)} thing(s) skipped:", file=sys.stderr)
        for w in warnings:
            print(f"  - {w}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    OPTIMIZE = "--optimize" in sys.argv[1:]
    sys.exit(main())
