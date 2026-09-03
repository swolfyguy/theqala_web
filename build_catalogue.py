#!/usr/bin/env python3
"""
Scan photos/ and write photos/catalogue.json.

ONE FOLDER = ONE PRODUCT. The folder name starts with the price.

    photos/<category>/<price> <optional name>/
        anything.jpg          every image is a view of that one piece
        anything.jpg          shown in filename order
        clip.mp4              optional video, shown in the gallery

So:

    photos/rajwadi/2300 Kolhapuri Thushi/
        1.jpg  2.jpg  3.jpg  turn.mp4

    -> Kolhapuri Thushi, Rajwadi, ₹2,300, filed under ₹2,000 – ₹3,000,
       four views including the video.

The price band is worked out from the price: 2300 falls in 2,000–3,000, 3100
in 3,000–4,000. You never make band folders yourself.

Also read:
    photos/<category>/anything.jpg      the tile for that category
    photos/hero.mp4  photos/hero-1.jpg  the home page

Each product keeps a small hidden `.id` file holding its number, so its
reference code (RAJWADI-07) survives a price change or a rename, and the
numbers of deleted products are never handed out again.

    python3 build_catalogue.py
    python3 build_catalogue.py --optimize     also shrink oversized photos
"""

import json
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PHOTOS = ROOT / "photos"
OUT = PHOTOS / "catalogue.json"

WEB_EXT = {".jpg", ".jpeg", ".jpe", ".jfif", ".png", ".webp", ".avif", ".gif", ".svg"}
CONVERT_EXT = {".heic", ".heif", ".tif", ".tiff", ".bmp", ".dib", ".ico", ".ppm", ".tga"}
IMAGE_EXT = WEB_EXT | CONVERT_EXT
VIDEO_EXT = {".mp4", ".webm", ".mov", ".m4v", ".ogv"}

PRODUCT_RE = re.compile(r"^(\d{2,8})\s*[-_. ]*\s*(.*)$")
OLD_BAND_RE = re.compile(r"^\d+-\d+$")

BIG_FILE = 400_000
MAX_WIDTH = 1400
OPTIMIZE = False
_pillow = None

warnings = []


def warn(msg):
    warnings.append(msg)


def rel(path):
    return path.relative_to(ROOT).as_posix()


# ---------------------------------------------------------------- video posters
#
# A <video> with no poster is a black rectangle until someone presses play. So for
# every video we pull one frame out and keep it in photos/.thumbs/. The frame is
# taken at 0.6s, because frame zero is very often a blur or a black fade-in.
#
_ffmpeg_exe = "unknown"


def ffmpeg_exe():
    """The ffmpeg we can actually run: the one pip ships with imageio-ffmpeg if it
       is installed, else whatever is on PATH. None if there is neither."""
    global _ffmpeg_exe
    if _ffmpeg_exe != "unknown":
        return _ffmpeg_exe
    _ffmpeg_exe = None
    try:
        import imageio_ffmpeg
        _ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        _ffmpeg_exe = shutil.which("ffmpeg")
    return _ffmpeg_exe


def poster_for(video):
    """The still for a video: a .jpg beside it, with the same name.

       video.mp4  ->  video.jpg
       Video-10132.mp4  ->  Video-10132.jpg

       If that file is already there we leave it alone — it may be a frame he
       picked himself. If it is missing we take one out of the video. To get a
       fresh one, delete the .jpg and run again."""
    out = video.with_suffix(".jpg")
    if out.exists():
        return rel(out)

    exe = ffmpeg_exe()
    if not exe:
        return None

    for seek in ("0.6", "0"):
        cmd = [exe, "-y", "-loglevel", "error", "-ss", seek, "-i", str(video),
               "-frames:v", "1", "-vf", "scale='min(1000,iw)':-2", "-q:v", "4", str(out)]
        try:
            subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           timeout=90, check=False)
        except Exception:
            return None
        if out.exists() and out.stat().st_size > 0:
            return rel(out)
    return None


def poster_of(video, files):
    """The still already sitting beside this video, if any. `files` is the folder
       listing, so we do not stat the disk twice."""
    stem = video.stem.lower()
    for f in files:
        if f.is_file() and f.stem.lower() == stem and f.suffix.lower() in IMAGE_EXT:
            return f
    return None


def poster_note():
    """Said once, at the end, if we had no ffmpeg to make posters with."""
    if ffmpeg_exe() is None:
        warn("I could not take a picture out of your videos, so each visitor's "
             "browser has to fetch part of every video to draw its own thumbnail. "
             "It works, but it costs them data. Fix it once with:  pip install "
             "imageio-ffmpeg  then run this again. Or save a .jpg next to each "
             "video with the same name — video.mp4 and video.jpg — and that "
             "picture is used as it is.")


def natural(name):
    return [int(p) if p.isdigit() else p.lower() for p in re.split(r"(\d+)", name)]


def band_for(price):
    low = max(0, (int(price) // 1000) * 1000)
    return {"min": low, "max": low + 1000}


# --------------------------------------------------------------------------- #
# pictures

def pillow():
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
                im.save(path, optimize=True)
            else:
                if im.mode not in ("RGB", "L"):
                    im = im.convert("RGB")
                im.save(path, "JPEG" if path.suffix.lower() in {".jpg", ".jpeg", ".jpe", ".jfif"} else None,
                        quality=82, optimize=True, progressive=True)
        after = path.stat().st_size
        if after < before:
            print(f"  optimised {rel(path)}  {before/1000:.0f} KB -> {after/1000:.0f} KB")
    except Exception as e:
        warn(f"could not optimise {rel(path)}: {e}")


def to_jpeg(src):
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


def media_in(folder):
    """Images (converted and optionally shrunk) and videos inside a product folder.
       A picture whose name matches a video in the same folder is that video's
       still, not another view of the piece, so it is left out of the gallery."""
    files = sorted((f for f in folder.iterdir() if f.is_file()), key=lambda f: natural(f.name))
    video_stems = {f.stem.lower() for f in files if f.suffix.lower() in VIDEO_EXT}
    images, videos = [], []
    for f in files:
        if f.name.startswith("."):
            continue
        if f.suffix.lower() in IMAGE_EXT and f.stem.lower() in video_stems:
            continue
        ext = f.suffix.lower()
        if ext in WEB_EXT:
            images.append(f)
        elif ext in CONVERT_EXT:
            converted = to_jpeg(f)
            if converted:
                images.append(converted)
        elif ext in VIDEO_EXT:
            videos.append(f)
        else:
            warn(f"not a picture or a video, ignored: {rel(f)}")

    seen, uniq = set(), []
    for f in images:
        if f not in seen:
            seen.add(f)
            uniq.append(f)
    for f in uniq:
        if OPTIMIZE:
            optimize(f)
        if f.stat().st_size > BIG_FILE:
            warn(f"{rel(f)} is {f.stat().st_size/1_000_000:.1f} MB — run "
                 f"`python3 build_catalogue.py --optimize` to shrink it")
    for v in videos:
        if v.stat().st_size > 6_000_000:
            warn(f"{rel(v)} is {v.stat().st_size/1_000_000:.1f} MB — trim it to 10 seconds and "
                 f"under about 4 MB, or the product page will crawl on mobile data")
    return sorted(uniq, key=lambda f: natural(f.name)), videos


# --------------------------------------------------------------------------- #
# stable numbers

def load_next():
    """The highest number ever handed out in each category, so none is reused."""
    try:
        old = json.loads(OUT.read_text(encoding="utf-8"))
    except Exception:
        return {}
    out = {}
    for c in old.get("categories", []):
        used = [p.get("n", 0) for p in c.get("products", [])]
        out[c.get("slug")] = max([c.get("next", 1) - 1] + used) + 1
    return out


def product_id(folder, slug, nxt, taken):
    """Read .id, or hand out the next free number and remember it in the folder."""
    idfile = folder / ".id"
    n = None
    try:
        n = int(idfile.read_text(encoding="utf-8").strip())
    except Exception:
        n = None
    if n is not None and n in taken:
        warn(f"{rel(folder)} shared a number with another product — it has been given a new one")
        n = None
    if n is None:
        n = nxt.get(slug, 1)
        while n in taken:
            n += 1
        try:
            idfile.write_text(str(n), encoding="utf-8")
        except Exception as e:
            warn(f"could not write {rel(idfile)}: {e}")
    taken.add(n)
    nxt[slug] = max(nxt.get(slug, 1), n + 1)
    return n


# --------------------------------------------------------------------------- #

def find_welcome():
    """photos/welcome.mp4 — the introduction video — and photos/welcome.jpg as its poster."""
    out = {"video": None, "poster": None}
    if not PHOTOS.is_dir():
        return out
    for f in sorted(PHOTOS.iterdir(), key=lambda p: natural(p.name)):
        if not f.is_file() or not f.stem.lower().startswith("welcome"):
            continue
        if f.suffix.lower() in VIDEO_EXT and out["video"] is None:
            out["video"] = rel(f)
            if f.stat().st_size > 40_000_000:
                warn(f"{rel(f)} is {f.stat().st_size/1_000_000:.0f} MB — Cloudflare Pages refuses "
                     f"any file over 25 MB. Compress it before you push.")
            elif f.stat().st_size > 12_000_000:
                warn(f"{rel(f)} is {f.stat().st_size/1_000_000:.0f} MB — it will play, but that is "
                     f"heavy for a customer on mobile data.")
        elif f.suffix.lower() in IMAGE_EXT and out["poster"] is None:
            out["poster"] = rel(f)
    if out["video"] and not out["poster"]:
        out["poster"] = poster_for(ROOT / out["video"])
    return out


def find_social():
    """photos/social/<key>.jpg — screenshots of the Instagram pages and the shop on Maps.
       The key is the filename; index.html maps it to a link."""
    folder = PHOTOS / "social"
    if not folder.is_dir():
        return {}
    out = {}
    for f in sorted(folder.iterdir(), key=lambda p: natural(p.name)):
        if f.is_file() and f.suffix.lower() in IMAGE_EXT and not f.name.startswith("."):
            if OPTIMIZE:
                optimize(f)
            out.setdefault(f.stem.lower(), rel(f))
    return out


def find_clients():
    """photos/clients/ — short videos of customers wearing their piece.
       One video per file; a still with the same name is used as its poster.
       A caption can ride along in the filename after a dash:
           priya-she-wore-the-thushi-at-her-haldi.mp4
       becomes  "She wore the thushi at her haldi"."""
    folder = PHOTOS / "clients"
    if not folder.is_dir():
        return []
    out = []
    for f in sorted(folder.iterdir(), key=lambda p: natural(p.name)):
        if not f.is_file() or f.suffix.lower() not in VIDEO_EXT or f.name.startswith("."):
            continue
        mb = f.stat().st_size / (1024 * 1024)
        if mb > 12:
            warn(f"{rel(f)} is {mb:.0f} MB. Every push keeps a copy of it forever — "
                 f"trim it or export it smaller before you commit.")
        poster = poster_for(f)
        if OPTIMIZE and poster:
            optimize(ROOT / poster)

        # A caption only if the name actually says something. "Video-10132" does
        # not, so that clip simply shows without a line under it.
        caption = ""
        if "-" in f.stem:
            rest = f.stem.split("-", 1)[1].replace("-", " ").replace("_", " ").strip()
            if re.search(r"[A-Za-z]{2}", rest) and len(rest) > 3:
                caption = rest[:1].upper() + rest[1:]

        out.append({"video": rel(f), "poster": poster, "caption": caption})
    return out


def find_reviews():
    """photos/reviews.json — what your customers said on Google.

       Fill it by hand, or later from the Google Business Profile API. Either
       way the shape is the same, so the website never has to change:

       {"url": "https://share.google/...",      the link to your listing
        "rating": 4.9, "count": 37,             what Google shows overall
        "reviews": [
          {"name": "Sneha K.", "stars": 5,
           "when": "2 months ago",
           "text": "..."}
        ]}

       Only "reviews" is required. Anything missing is simply not shown."""
    f = PHOTOS / "reviews.json"
    if not f.is_file():
        return None
    try:
        data = json.loads(f.read_text(encoding="utf-8"))
    except Exception as e:
        warn(f"photos/reviews.json could not be read ({e}). The reviews section is skipped.")
        return None
    items = []
    for r in (data.get("reviews") or []):
        text = str(r.get("text") or "").strip()
        name = str(r.get("name") or "").strip()
        if not text or not name:
            warn("a review in photos/reviews.json has no name or no text — skipped")
            continue
        try:
            stars = int(r.get("stars") or 5)
        except Exception:
            stars = 5
        items.append({"name": name, "text": text,
                      "stars": max(1, min(5, stars)),
                      "when": str(r.get("when") or "").strip()})
    if not items:
        return None
    out = {"reviews": items}
    if data.get("url"):
        out["url"] = str(data["url"])
    if data.get("rating"):
        out["rating"] = data["rating"]
    if data.get("count"):
        out["count"] = data["count"]
    return out


def find_hero():
    hero = {"image": None, "video": None}
    if not PHOTOS.is_dir():
        return hero
    for f in sorted(PHOTOS.iterdir(), key=lambda p: natural(p.name)):
        if not f.is_file() or not f.stem.lower().startswith("hero"):
            continue
        if f.suffix.lower() in IMAGE_EXT and hero["image"] is None:
            hero["image"] = rel(f)
        elif f.suffix.lower() in VIDEO_EXT and hero["video"] is None:
            hero["video"] = rel(f)
    if hero["video"] and not hero["image"]:
        hero["image"] = poster_for(ROOT / hero["video"])
    return hero


def read_category(catdir, nxt):
    slug = catdir.name
    products, taken = [], set()

    for folder in sorted((d for d in catdir.iterdir() if d.is_dir()), key=lambda d: natural(d.name)):
        name = folder.name.strip()
        if OLD_BAND_RE.match(name):
            # left over from the old price-band layout. Say nothing if it is empty;
            # only speak up when there are photographs stranded in it.
            stranded = [f for f in folder.rglob("*")
                        if f.is_file() and f.suffix.lower() in IMAGE_EXT and not f.name.startswith(".")]
            if stranded:
                warn(f"{rel(folder)} is an old price-band folder holding {len(stranded)} "
                     f"photograph(s). Every product now gets its own folder named after its price — "
                     f"add them again in the studio with their real price, then delete this folder.")
            continue
        m = PRODUCT_RE.match(name)
        if not m:
            warn(f"{rel(folder)} should start with the price, e.g. '2300 Kolhapuri Thushi' — skipped")
            continue
        price = int(m.group(1))
        title = re.sub(r"\s+", " ", m.group(2)).strip()
        # "800 (2)" is a folder the studio had to make unique, not a piece called "(2)"
        title = re.sub(r"^\((\d+)\)$", "", title).strip()

        images, videos = media_in(folder)
        if not images and not videos:
            warn(f"{rel(folder)} has no pictures in it — skipped")
            continue
        if not images:
            warn(f"{rel(folder)} has a video but no picture — add at least one photograph")
            continue

        n = product_id(folder, slug, nxt, taken)
        products.append({
            "n": n,
            "code": f"{slug.upper()}-{n:02d}",
            "folder": rel(folder),
            "title": title,
            "price": price,
            "band": band_for(price),
            "images": [rel(f) for f in images],
            "video": rel(videos[0]) if videos else None,
            "videoPoster": poster_for(videos[0]) if videos else None,
        })
        if len(videos) > 1:
            warn(f"{rel(folder)} has more than one video — only {videos[0].name} is used")

    products.sort(key=lambda p: (p["price"], p["n"]))

    covers = [f for f in sorted(catdir.iterdir(), key=lambda p: natural(p.name))
              if f.is_file() and f.suffix.lower() in IMAGE_EXT and not f.name.startswith(".")]
    return {
        "slug": slug,
        "cover": rel(covers[0]) if covers else None,
        "next": nxt.get(slug, 1),
        "products": products,
    }


def main():
    if not PHOTOS.is_dir():
        print(f"no photos/ folder at {PHOTOS}", file=sys.stderr)
        return 1

    nxt = load_next()
    categories, bands = [], {}
    total_products = total_files = 0

    for catdir in sorted((p for p in PHOTOS.iterdir() if p.is_dir()), key=lambda d: natural(d.name)):
        if catdir.name[0] in "._" or catdir.name.lower() in ("social", "clients"):
            continue
        cat = read_category(catdir, nxt)
        for p in cat["products"]:
            bands[p["band"]["min"]] = p["band"]
            total_files += len(p["images"]) + (1 if p["video"] else 0)
        total_products += len(cat["products"])
        if cat["products"] or cat["cover"]:
            categories.append(cat)

    data = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "version": 2,
        "hero": find_hero(),
        "welcome": find_welcome(),
        "social": find_social(),
        "clients": find_clients(),
        "reviews": find_reviews(),
        "bands": [bands[k] for k in sorted(bands)],
        "categories": categories,
    }
    poster_note()
    OUT.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")

    print(f"{OUT.relative_to(ROOT)}: {total_products} product{'' if total_products == 1 else 's'}, "
          f"{total_files} files, {len(categories)} categor{'y' if len(categories) == 1 else 'ies'}")
    for c in categories:
        if c["products"]:
            cheapest = min(p["price"] for p in c["products"])
            dearest = max(p["price"] for p in c["products"])
            span = f"₹{cheapest:,}" if cheapest == dearest else f"₹{cheapest:,}–₹{dearest:,}"
            print(f"  {c['slug']:<20} {len(c['products'])} product(s), {span}")
        else:
            print(f"  {c['slug']:<20} (nothing yet)")
    if warnings:
        print(f"\n{len(warnings)} thing(s) to look at:", file=sys.stderr)
        for w in warnings:
            print(f"  - {w}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    OPTIMIZE = "--optimize" in sys.argv[1:]
    sys.exit(main())
