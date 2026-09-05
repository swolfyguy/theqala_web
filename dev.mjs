/* ---------------------------------------------------------------------------
   The Qala — run the whole website on this computer, exactly as it behaves
   on Cloudflare: the shop, the order form, the database and the order book.

       node dev.mjs

   Then open http://localhost:8788

   Nothing to install. It uses the real _worker.js and a real SQLite database
   in a file called .qala-dev.sqlite, which is ignored by git and can be
   deleted whenever you want a clean start.

   This is not Cloudflare's own runtime — for that see the note at the bottom
   of claude/qala-orders.md — but it runs the same code against the same SQL,
   which is enough to try every screen before you push.
--------------------------------------------------------------------------- */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {DatabaseSync} from "node:sqlite";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8788);
/* Deliberately not the real password — this file sits in the repository.
   To try the real one:  set STUDIO_PASSWORD=... before running. */
const PASSWORD = process.env.STUDIO_PASSWORD || "qala-dev";
const DBFILE = path.join(ROOT, ".qala-dev.sqlite");

/* ---------- a database that behaves like D1 ---------- */

const SCHEMA = fs.readFileSync(path.join(ROOT, "schema.sql"), "utf8")
  .split("\n").filter(l => !l.trim().startsWith("--")).join("\n");

/* A file, so orders survive a restart. Some folders cannot hold a SQLite
   file — a network drive, OneDrive, a shared folder — so fall back to
   memory rather than refusing to start. */
let sqlite, kept = DBFILE;
try {
  sqlite = new DatabaseSync(DBFILE);
  sqlite.exec(SCHEMA);
} catch (err) {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(SCHEMA);
  kept = null;
}

const DB = {
  prepare(sql) {
    const make = args => ({
      bind: (...a) => make(a),
      async first() { const r = sqlite.prepare(sql).get(...args); return r ? {...r} : null; },
      async all()   { return {results: sqlite.prepare(sql).all(...args).map(r => ({...r}))}; },
      async run()   { sqlite.prepare(sql).run(...args); return {success: true}; }
    });
    return make([]);
  }
};

/* ---------- the files of the site ---------- */

const TYPES = {
  ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8",
  ".css":"text/css; charset=utf-8",   ".json":"application/json; charset=utf-8",
  ".svg":"image/svg+xml", ".jpg":"image/jpeg", ".jpeg":"image/jpeg", ".png":"image/png",
  ".webp":"image/webp",   ".gif":"image/gif",  ".ico":"image/x-icon",
  ".mp4":"video/mp4",     ".webm":"video/webm", ".woff2":"font/woff2", ".txt":"text/plain"
};

const ASSETS = {
  async fetch(request) {
    let p = decodeURIComponent(new URL(request.url).pathname);

    /* The studio is a different server on a different port. Opened from here it
       would find no studio API, fall back to committing straight to GitHub, and
       a "test" upload would land on the live site. So it is not served here. */
    if (/^\/admin\.html$/i.test(p)) return new Response(
      `<!doctype html><meta charset=utf-8>
       <title>Wrong window</title>
       <style>body{font:16px/1.6 system-ui;max-width:34rem;margin:16vh auto;padding:0 6vw;
       background:#FAF3EB;color:#2A1A14}a{color:#7E1226}code{background:#F1E5D6;padding:1px 5px;
       border-radius:4px}</style>
       <h1 style="font-weight:400">The studio lives next door</h1>
       <p>This window is the order side — the shop, the order form and the order book.
       It has no studio API, so <code>admin.html</code> opened here would try to commit
       straight to GitHub, and a test upload would reach the live site.</p>
       <p>Close this and run <code>preview.bat</code> instead. The studio is at
       <a href="http://localhost:8000/admin.html">localhost:8000/admin.html</a>.</p>`,
      {status: 409, headers: {"content-type": "text/html; charset=utf-8"}});

    if (p.endsWith("/")) p += "index.html";
    if (p === "") p = "/index.html";
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory())
      return new Response("Not found", {status: 404});
    return new Response(fs.readFileSync(file), {
      headers: {"content-type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream"}
    });
  }
};

/* ---------- the worker itself, reloaded whenever you save it ---------- */

let worker = null, workerAt = 0;
async function loadWorker() {
  const src = fs.readFileSync(path.join(ROOT, "_worker.js"), "utf8");
  const stamp = fs.statSync(path.join(ROOT, "_worker.js")).mtimeMs;
  if (worker && stamp === workerAt) return worker;
  /* imported as a data URL so _worker.js stays exactly as Cloudflare wants it */
  const mod = await import("data:text/javascript;base64," + Buffer.from(src).toString("base64"));
  worker = mod.default; workerAt = stamp;
  return worker;
}

const ENV = {DB, ASSETS, STUDIO_PASSWORD: PASSWORD};

/* ---------- glue between node's http and the worker's fetch ---------- */

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;

  const request = new Request("http://localhost:" + PORT + req.url, {
    method: req.method,
    headers: Object.entries(req.headers).flatMap(([k, v]) =>
      Array.isArray(v) ? v.map(x => [k, x]) : (v == null ? [] : [[k, v]])),
    body: (req.method === "GET" || req.method === "HEAD") ? undefined : body,
    duplex: "half"
  });
  /* Cloudflare puts the visitor's address here; the flood guards read it. */
  request.headers.set("CF-Connecting-IP", req.socket.remoteAddress || "127.0.0.1");

  let out;
  try {
    const w = await loadWorker();
    out = await w.fetch(request, ENV, {});
  } catch (err) {
    console.error(err);
    out = new Response("dev server: " + err.message, {status: 500});
  }

  /* Secure cookies are fine on localhost in Chrome, Edge and Firefox, but
     not over a plain http:// address on your phone. Dropped here so you can
     also open this from another device on the same wifi. */
  const headers = {};
  for (const [k, v] of out.headers) {
    headers[k] = k.toLowerCase() === "set-cookie" ? v.replace(/;\s*Secure/i, "") : v;
  }
  res.writeHead(out.status, headers);
  res.end(Buffer.from(await out.arrayBuffer()));
}).listen(PORT, () => {
  const rows = sqlite.prepare("SELECT COUNT(*) AS n FROM orders").get().n;
  console.log(`
  The Qala is running on this computer.

    the shop        http://localhost:${PORT}/
    the order book  http://localhost:${PORT}/office/

    password        ${PASSWORD}
    numbers         90112 40352 · 75582 09163 · 95796 28754

    database        ${kept
      ? `.qala-dev.sqlite  (${rows} order${rows === 1 ? "" : "s"} so far)
                    delete that file for a clean start`
      : `in memory only — this folder cannot hold a database file,
                    so orders will disappear when you stop this`}

  Ctrl+C to stop.
`);
});
