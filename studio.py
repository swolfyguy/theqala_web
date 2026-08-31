#!/usr/bin/env python3
"""
The Qala — local studio server.

Serves this folder at http://localhost:8000 and lets admin.html add, delete and
move photographs in the real `photos` folder on this computer. Nothing goes to
GitHub: you commit and push yourself when you are ready.

    python studio.py

Stops with Ctrl+C. Only listens on this machine — nothing else on the network
can reach it.
"""

import base64
import contextlib
import subprocess
import io
import json
import os
import re
import sys
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parent
PHOTOS = ROOT / "photos"
PORT = int(os.environ.get("PORT", "8000"))
MAX_BODY = 80 * 1024 * 1024          # 80 MB per request

IMAGE_EXT = {".jpg", ".jpeg", ".jpe", ".jfif", ".png", ".webp", ".avif",
             ".gif", ".svg", ".heic", ".heif", ".tif", ".tiff", ".bmp"}
SAFE_NAME = re.compile(r"^[^\\/:*?\"<>|\x00-\x1f]{1,120}$")

sys.path.insert(0, str(ROOT))
try:
    import build_catalogue
except Exception as e:                                     # pragma: no cover
    build_catalogue = None
    print(f"! could not import build_catalogue.py ({e}) — the catalogue will not rebuild")


# --------------------------------------------------------------------------- #

def rebuild(optimize=True):
    """Re-run build_catalogue and hand back what it printed."""
    if build_catalogue is None:
        return {"ok": False, "log": ["build_catalogue.py is missing"], "warnings": []}
    out, err = io.StringIO(), io.StringIO()
    build_catalogue.warnings.clear()
    build_catalogue.OPTIMIZE = optimize
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            build_catalogue.main()
    except Exception as e:
        return {"ok": False, "log": [f"build failed: {e}"], "warnings": []}
    finally:
        build_catalogue.OPTIMIZE = False
    return {
        "ok": True,
        "log": [l for l in out.getvalue().splitlines() if l.strip()],
        "warnings": list(build_catalogue.warnings),
    }


def inside_photos(rel):
    """Resolve a photos/... path and refuse anything that escapes the folder."""
    rel = unquote(str(rel)).replace("\\", "/").lstrip("/")
    if not rel.startswith("photos/"):
        raise ValueError(f"outside the photos folder: {rel}")
    parts = [p for p in rel.split("/")[1:] if p not in ("", ".")]
    if any(p == ".." for p in parts) or not parts:
        raise ValueError(f"bad path: {rel}")
    for p in parts:
        if not SAFE_NAME.match(p):
            raise ValueError(f"bad name: {p}")
    target = (PHOTOS / Path(*parts)).resolve()
    if PHOTOS.resolve() not in target.parents and target != PHOTOS.resolve():
        raise ValueError(f"outside the photos folder: {rel}")
    return target


def list_photos():
    if not PHOTOS.is_dir():
        return []
    out = []
    for p in sorted(PHOTOS.rglob("*")):
        if p.is_file() and not p.name.startswith("."):
            out.append(p.relative_to(ROOT).as_posix())
    return out


def list_folders():
    if not PHOTOS.is_dir():
        return []
    return sorted(p.relative_to(ROOT).as_posix() for p in PHOTOS.rglob("*") if p.is_dir())


def read_catalogue():
    try:
        return json.loads((PHOTOS / "catalogue.json").read_text(encoding="utf-8"))
    except Exception:
        return None


# ---------------------------------------------------------------------------
# git

def git(*args, timeout=180):
    return subprocess.run(["git", *args], cwd=str(ROOT), capture_output=True,
                          text=True, timeout=timeout)


def git_state():
    st = {"installed": False, "repo": False, "branch": "", "remote": "",
          "upstream": "", "changes": [], "ahead": 0, "last": "", "note": ""}
    try:
        if git("--version").returncode != 0:
            return st
    except Exception:
        st["note"] = "git is not installed, or not on the PATH"
        return st
    st["installed"] = True

    if git("rev-parse", "--is-inside-work-tree").returncode != 0:
        st["note"] = "this folder is not a git repository yet — run `git init`"
        return st
    st["repo"] = True

    st["branch"] = git("rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
    remotes = git("remote").stdout.split()
    st["remote"] = remotes[0] if remotes else ""
    if not st["remote"]:
        st["note"] = "no remote yet — run `git remote add origin <url>` once"

    up = git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")
    st["upstream"] = up.stdout.strip() if up.returncode == 0 else ""

    for line in git("status", "--porcelain").stdout.splitlines():
        if len(line) > 3:
            st["changes"].append({"status": line[:2].strip() or "?", "path": line[3:].strip()})

    if st["upstream"]:
        ahead = git("rev-list", "--count", "@{u}..HEAD")
        if ahead.returncode == 0 and ahead.stdout.strip().isdigit():
            st["ahead"] = int(ahead.stdout.strip())
    elif st["repo"]:
        cnt = git("rev-list", "--count", "HEAD")
        if cnt.returncode == 0 and cnt.stdout.strip().isdigit():
            st["ahead"] = int(cnt.stdout.strip())

    last = git("log", "-1", "--pretty=%h %s")
    st["last"] = last.stdout.strip() if last.returncode == 0 else ""
    return st


def prune_empty(folder):
    """After a delete, drop the piece folder if nothing is left in it."""
    try:
        folder = folder.resolve()
        if PHOTOS.resolve() not in folder.parents:
            return
        while folder != PHOTOS.resolve() and folder.is_dir():
            remaining = [f for f in folder.iterdir() if not f.name.startswith(".")]
            if remaining:
                return
            for f in folder.iterdir():
                f.unlink()
            folder.rmdir()
            folder = folder.parent
    except Exception:
        pass


# --------------------------------------------------------------------------- #

class Studio(SimpleHTTPRequestHandler):
    server_version = "QalaStudio/1.0"

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def log_message(self, fmt, *args):
        if "/api/" in (self.path or ""):
            sys.stderr.write("  %s %s\n" % (self.command, self.path))

    # ---------- helpers ----------
    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            raise ValueError("that batch is too large — send fewer photographs at a time")
        return json.loads(self.rfile.read(length) or b"{}")

    def local_only(self):
        host = (self.headers.get("Host") or "").split(":")[0]
        if host not in ("localhost", "127.0.0.1", "[::1]", "::1"):
            self.send_json({"error": "this server only answers to localhost"}, 403)
            return False
        return True

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    # ---------- routing ----------
    def do_GET(self):
        if urlparse(self.path).path == "/api/git":
            if not self.local_only():
                return
            return self.send_json(git_state())
        if urlparse(self.path).path == "/api/state":
            if not self.local_only():
                return
            return self.send_json({
                "ok": True,
                "mode": "local",
                "root": str(ROOT),
                "photos": list_photos(),
                "folders": list_folders(),
                "catalogue": read_catalogue(),
            })
        return super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        if not path.startswith("/api/"):
            return self.send_error(404)
        if not self.local_only():
            return
        try:
            if path == "/api/upload":  return self.api_upload()
            if path == "/api/delete":  return self.api_delete()
            if path == "/api/move":    return self.api_move()
            if path == "/api/build":   return self.send_json(rebuild())
            if path == "/api/git":     return self.api_git()
        except ValueError as e:
            return self.send_json({"error": str(e)}, 400)
        except Exception as e:
            return self.send_json({"error": f"{type(e).__name__}: {e}"}, 500)
        self.send_error(404)

    # ---------- actions ----------
    def api_upload(self):
        data = self.read_json()
        files = data.get("files") or []
        if not files:
            raise ValueError("nothing to save")
        written = []
        for f in files:
            target = inside_photos(f.get("path", ""))
            if target.suffix.lower() not in IMAGE_EXT:
                raise ValueError(f"not an image: {target.name}")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(base64.b64decode(f.get("b64") or ""))
            written.append(target.relative_to(ROOT).as_posix())
        result = rebuild()
        result.update({"written": written, "photos": list_photos(), "folders": list_folders(), "catalogue": read_catalogue()})
        return self.send_json(result)

    def api_delete(self):
        data = self.read_json()
        paths = data.get("paths") or []
        if not paths:
            raise ValueError("nothing to delete")
        removed = []
        for rel in paths:
            target = inside_photos(rel)
            if target.is_file():
                parent = target.parent
                target.unlink()
                removed.append(target.relative_to(ROOT).as_posix())
                prune_empty(parent)
        result = rebuild(optimize=False)
        result.update({"removed": removed, "photos": list_photos(), "folders": list_folders(), "catalogue": read_catalogue()})
        return self.send_json(result)

    def api_git(self):
        """Stage everything, commit, and push. One button on the studio."""
        data = self.read_json()
        message = (data.get("message") or "").strip() or "Update photographs"
        log = []
        st = git_state()
        if not st["installed"]:
            raise ValueError("git is not installed, or not on the PATH")
        if not st["repo"]:
            raise ValueError("this folder is not a git repository yet — run `git init` in it once")

        if git("status", "--porcelain").stdout.strip():
            r = git("add", "-A")
            if r.returncode != 0:
                raise ValueError("git add failed: " + (r.stderr or r.stdout).strip())
            r = git("commit", "-m", message)
            if r.returncode != 0 and "nothing to commit" not in (r.stdout + r.stderr).lower():
                raise ValueError("git commit failed: " + (r.stderr or r.stdout).strip())
            log += [l for l in (r.stdout or "").splitlines() if l.strip()][:3]
        else:
            log.append("nothing new to commit")

        st = git_state()
        if not st["remote"]:
            result = {"ok": True, "log": log + ["no remote set, so nothing was pushed"],
                      "pushed": False, "git": st}
            return self.send_json(result)

        args = ["push"] if st["upstream"] else ["push", "-u", st["remote"], st["branch"]]
        r = git(*args)
        out = ((r.stdout or "") + (r.stderr or "")).strip()
        if r.returncode != 0:
            raise ValueError("git push failed:\n" + (out or "no output") +
                             "\n\nIf it is asking for a password, push once from a terminal so "
                             "Windows remembers the credentials, then this button will work.")
        log += [l for l in out.splitlines() if l.strip()][-4:]
        return self.send_json({"ok": True, "log": log, "pushed": True, "git": git_state()})

    def api_move(self):
        data = self.read_json()
        pairs = data.get("pairs") or []
        if not pairs:
            raise ValueError("nothing to move")
        moved = []
        for pair in pairs:
            src = inside_photos(pair.get("from", ""))
            dst = inside_photos(pair.get("to", ""))
            if not src.is_file():
                raise ValueError(f"missing: {src.name}")
            dst.parent.mkdir(parents=True, exist_ok=True)
            if dst.exists():
                raise ValueError(f"already there: {dst.name}")
            parent = src.parent
            src.replace(dst)
            prune_empty(parent)
            moved.append(dst.relative_to(ROOT).as_posix())
        result = rebuild(optimize=False)
        result.update({"moved": moved, "photos": list_photos(), "folders": list_folders(), "catalogue": read_catalogue()})
        return self.send_json(result)


def main():
    if not PHOTOS.is_dir():
        print(f"! no photos folder at {PHOTOS}")
    print("\n  The Qala — studio\n")
    print(f"  folder   {ROOT}")
    print(f"  shop     http://localhost:{PORT}/")
    print(f"  studio   http://localhost:{PORT}/admin.html")
    print("\n  Changes are written straight into the folder above.")
    print("  Commit and push when you are ready. Ctrl+C to stop.\n")
    first = rebuild(optimize=False)
    for line in first["log"]:
        print("  " + line)
    for w in first["warnings"]:
        print("  ! " + w)
    print()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Studio)
    threading.Timer(0.6, lambda: webbrowser.open(f"http://localhost:{PORT}/admin.html")).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  stopped\n")


if __name__ == "__main__":
    main()
