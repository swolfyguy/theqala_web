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


STOCK_FILE = "stock.json"
# The poth lengths the shop makes, in inches. Same list as the order form.
SIZES = [str(n) for n in range(24, 41, 2)]


def read_stock(folder):
    """Everything stock.json says about a piece: how many, what lengths, and
       whether it may be sent cash on delivery.

       Cash on delivery is off unless the file says {"cod": true}. The shop
       decides it piece by piece, because a courier carrying cash costs money
       and is not worth it on everything."""
    out = _read_sizes(folder)
    f = folder / STOCK_FILE
    if f.is_file():
        try:
            raw = json.loads(f.read_text(encoding="utf-8"))
            if isinstance(raw, dict) and raw.get("cod") is True:
                out["cod"] = True
        except Exception:
            pass                       # _read_sizes has already said so
    return out


def _read_sizes(folder):
    """The poth lengths this piece comes in, as a range.

       photos/<cat>/<price> <name>/stock.json holds

           {"qty": 3, "min": 24, "max": 36}

       qty  — how many of this piece the shop has. Missing means one.
       min/max — the shortest and longest poth it is made in. Missing means
       the piece has no poth at all, and the shop asks for no length.

       An older file listing a count against each size is still understood:
       the smallest and largest length in it become the range."""
    f = folder / STOCK_FILE
    if not f.is_file():
        return {"qty": 1}                 # no file: one of it, no poth lengths
    try:
        raw = json.loads(f.read_text(encoding="utf-8"))
    except Exception as e:
        warn(f"{rel(f)} is not readable as JSON ({e}) — treated as one, with no lengths")
        return {"qty": 1}
    if not isinstance(raw, dict) or not raw:
        warn(f'{rel(f)} should look like {{"qty": 3, "min": 24, "max": 36}} — treated as one')
        return {"qty": 1}

    qty = raw.get("qty", raw.get("quantity"))
    if qty is None:
        made = 1                      # nothing said means one of it
    else:
        try:
            made = int(qty)
        except Exception:
            warn(f"{rel(f)} has {qty!r} as the quantity, which is not a number — treated as one")
            made = 1
        if made < 0:
            warn(f"{rel(f)} has {made} as the quantity — treated as none left")
            made = 0

    if "min" in raw or "max" in raw:
        lo, hi = raw.get("min"), raw.get("max")
    else:
        # the older shape: {"24": 1, "28": 2}
        found = [k for k in raw if str(k).strip() in SIZES]
        if not found:
            return {"qty": made}          # a quantity on its own is perfectly normal
        lo, hi = min(found, key=int), max(found, key=int)

    lo, hi = str(lo).strip(), str(hi).strip()
    if lo not in SIZES or hi not in SIZES:
        warn(f"{rel(f)} gives {lo}–{hi}, and the shop makes even lengths "
             f"{SIZES[0]} to {SIZES[-1]} — the lengths ignored")
        return {"qty": made}
    if int(lo) > int(hi):
        warn(f"{rel(f)} has the shortest length ({lo}) longer than the longest ({hi}) — "
             f"turned around")
        lo, hi = hi, lo
    return {"min": int(lo), "max": int(hi), "qty": made}


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
        if f.name.lower() == STOCK_FILE:      # how many of each size — not a picture
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
        item = {"name": name, "text": text, "when": str(r.get("when") or "").strip()}
        # Stars are optional. If we do not know how many a person gave, we show
        # none rather than assume five.
        if r.get("stars") not in (None, ""):
            try:
                item["stars"] = max(1, min(5, int(r["stars"])))
            except Exception:
                pass
        items.append(item)
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
            "sizes": read_stock(folder),
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


SITE = "https://theqalashree.com"

def write_sitemap(categories):
    """A sitemap that lists what actually exists.

       Until now every piece lived only behind a # (#/piece/CODE), and
       Google does not treat what follows a # as a page of its own — so
       the old version of this function listed just the shop and the
       order link as real <url> entries, with every piece's cover photo
       bundled as an <image:image> under the homepage instead. That was
       an honest tradeoff for a hash-only site, not a design to keep.

       prerender.mjs now bakes every product, category and policy route
       into a real file at a real path (piece/<code>/, shop/<slug>/,
       terms/, privacy/, shipping/, returns/, refunds/) before this
       script ever runs, so those addresses are real pages a crawler can
       fetch directly. This function lists one <url> per page that
       prerender.mjs writes, plus the homepage and /order, and keeps the
       full <image:image> list on each product's own <url> — now that a
       product's images sit on that product's page rather than smuggled
       onto the homepage, there is no cap forcing us to keep to just the
       first shot."""
    esc = lambda t: (str(t).replace("&", "&amp;").replace("<", "&lt;")
                          .replace(">", "&gt;").replace('"', "&quot;"))
    # a path may hold spaces and brackets - photos/hand-made-rajwadi/1000 (2)/1.jpg
    from urllib.parse import quote
    img_url = lambda rel: SITE + "/" + quote(str(rel).replace("\\", "/"))

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    lines = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
             '        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">']

    def entry(loc, changefreq, priority, images=None):
        lines.append("  <url>")
        lines.append(f"    <loc>{esc(loc)}</loc>")
        lines.append(f"    <lastmod>{today}</lastmod>")
        lines.append(f"    <changefreq>{changefreq}</changefreq>")
        lines.append(f"    <priority>{priority}</priority>")
        for src, title, caption in images or []:
            lines.append("    <image:image>")
            lines.append(f"      <image:loc>{esc(src)}</image:loc>")
            lines.append(f"      <image:title>{esc(title)}</image:title>")
            lines.append(f"      <image:caption>{esc(caption)}</image:caption>")
            lines.append("    </image:image>")
        lines.append("  </url>")

    entry(f"{SITE}/", "daily", "1.0")
    entry(f"{SITE}/order", "monthly", "0.5")

    url_count = 2
    for c in categories:
        entry(f"{SITE}/shop/{c['slug']}/", "weekly", "0.8")
        url_count += 1
        for pr in c["products"]:
            name = pr["title"].strip() or f"{c['slug'].replace('-', ' ')} {pr['n']}"
            images = [(img_url(img),
                       f"{name} - handmade jewellery from The Qala, Dighi, Pune",
                       f"{name} - Rs {pr['price']}")
                      for img in pr["images"]]
            entry(f"{SITE}/piece/{pr['code'].lower()}/", "weekly", "0.7", images)
            url_count += 1

    for r in ("terms", "privacy", "shipping", "returns", "refunds"):
        entry(f"{SITE}/{r}/", "monthly", "0.3")
        url_count += 1

    lines += ["</urlset>", ""]
    (ROOT / "sitemap.xml").write_text("\n".join(lines), encoding="utf-8")
    return url_count


def write_robots():
    """Cloudflare serves a robots.txt of its own when nothing is here. That one
       says nothing about where the sitemap is, so we write our own."""
    (ROOT / "robots.txt").write_text(
        "# The Qala - theqalashree.com\n"
        "# Everything here is meant to be found. Nothing is hidden from search\n"
        "# except the two doors that need a password, which hold nothing a\n"
        "# search engine could use anyway.\n"
        "\n"
        "User-agent: *\n"
        "Allow: /\n"
        "Disallow: /office/\n"
        "Disallow: /studio/\n"
        "Disallow: /api/\n"
        "\n"
        f"Sitemap: {SITE}/sitemap.xml\n", encoding="utf-8")


def write_llms_txt(categories, total_products):
    """A plain-text summary for LLM crawlers (ChatGPT, Perplexity and the
       like), at the repo root as /llms.txt, alongside robots.txt and
       sitemap.xml. There's no established schema for this file the way
       there is for a sitemap — the emerging convention is just short,
       factual, plain-English prose an answer engine can quote from
       directly, so that's what this writes: what the shop is, how to
       order, what it charges for shipping and returns, and where the
       real pages (not the # ones) live. Built from the same catalogue
       data and the same policy wording as everything else here, so it
       can't say something the site itself doesn't."""
    titleish = lambda s: " ".join(w.capitalize() for w in s.replace("_", "-").split("-"))
    lines = [
        "# The Qala",
        "",
        "> Handmade Rajwadi, Victorian and moissanite jewellery — thushi, saaj, "
        "mangalsutra, bangles and bridal pieces — made by hand in Dighi, Pune, "
        "India, and shipped insured across India. Orders are placed on WhatsApp.",
        "",
        f"The shop currently lists {total_products} pieces across {len(categories)} categories.",
        "",
        "## Shop",
        "",
    ]
    for c in categories:
        if not c["products"]:
            continue
        cheapest = min(p["price"] for p in c["products"])
        dearest = max(p["price"] for p in c["products"])
        span = f"Rs {cheapest:,}" if cheapest == dearest else f"Rs {cheapest:,}-{dearest:,}"
        lines.append(f"- [{titleish(c['slug'])}]({SITE}/shop/{c['slug']}/): "
                      f"{len(c['products'])} piece(s), {span}")
    lines += [
        "",
        "Each piece also has its own page at "
        f"{SITE}/piece/<product-code>/ with its price, images and current "
        "availability.",
        "",
        "## Ordering",
        "",
        "- Orders are placed on WhatsApp, not through an online checkout.",
        "- Payment: online by UPI, bank transfer or a payment link, cash at "
        "the shop in Dighi, or cash on delivery on pieces marked for it "
        "(an extra courier charge applies).",
        "- Shipping: free insured shipping over the shop's free-shipping "
        "threshold, a flat fee below it. Ready pieces dispatch within two "
        "working days; made-to-order pieces take five to seven days. "
        "Delivery is two days across most of Maharashtra, three to five "
        "days elsewhere in India.",
        "- Returns: a damaged, wrong or defective piece is replaced or "
        "refunded, provided an unbroken unboxing video is sent on WhatsApp "
        "with the order reference within 48 hours of delivery. Pieces are "
        "not accepted back simply because a buyer changed their mind, since "
        "each is checked, polished and packed by hand before it ships.",
        "- Cancellations: an order can be cancelled for any reason any time "
        "before it is handed to the courier.",
        "",
        "## Policies",
        "",
        f"- Shipping & cash on delivery: {SITE}/shipping/",
        f"- Returns & damage: {SITE}/returns/",
        f"- Refunds & cancellation: {SITE}/refunds/",
        f"- Terms & conditions: {SITE}/terms/",
        f"- Privacy policy: {SITE}/privacy/",
        "",
        "## Site structure",
        "",
        f"- {SITE}/ — homepage",
        f"- {SITE}/shop/<category-slug>/ — one page per category",
        f"- {SITE}/piece/<product-code>/ — one page per product, with "
        "Product structured data (price, availability, SKU, images)",
        f"- {SITE}/sitemap.xml — full sitemap",
        "",
    ]
    (ROOT / "llms.txt").write_text("\n".join(lines), encoding="utf-8")


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

    url_count = write_sitemap(categories)
    write_robots()
    write_llms_txt(categories, total_products)

    print(f"{OUT.relative_to(ROOT)}: {total_products} product{'' if total_products == 1 else 's'}, "
          f"{total_files} files, {len(categories)} categor{'y' if len(categories) == 1 else 'ies'}")
    print(f"sitemap.xml: {url_count} urls, robots.txt, llms.txt")
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
