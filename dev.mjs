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

/* Columns added to the orders table after the first version. SQLite has no
   "add this column if it is missing", so each one is asked for and its
   complaint ignored — which is exactly what you do by hand on D1. */
const LATER = [
  "ALTER TABLE orders ADD COLUMN poth TEXT DEFAULT ''",
  "ALTER TABLE orders ADD COLUMN source TEXT NOT NULL DEFAULT 'site'",
  "ALTER TABLE orders ADD COLUMN photo TEXT DEFAULT ''",
  "ALTER TABLE orders ADD COLUMN memo TEXT DEFAULT ''",
  "ALTER TABLE orders ADD COLUMN memo_by TEXT DEFAULT ''",
  "ALTER TABLE orders ADD COLUMN memo_at TEXT DEFAULT ''",
  "ALTER TABLE orders ADD COLUMN anjani_set TEXT DEFAULT ''",
  "ALTER TABLE parcels ADD COLUMN by_hand TEXT DEFAULT ''",
  "ALTER TABLE parcels ADD COLUMN by_hand_at TEXT DEFAULT ''",
  "ALTER TABLE parcels ADD COLUMN ref TEXT DEFAULT ''",
  "ALTER TABLE parcels ADD COLUMN phone TEXT DEFAULT ''",
  "CREATE INDEX IF NOT EXISTS parcels_ref   ON parcels (ref)",
  "CREATE INDEX IF NOT EXISTS parcels_phone ON parcels (phone)"
];

const ready = db => {
  db.exec(SCHEMA);
  for (const line of LATER) { try { db.exec(line); } catch { /* already there */ } }
  return db;
};

/* ---------- mock data, so a fresh database is never an empty one ---------- */

/* Only ever runs against an empty orders table — never on a database that
   already has real (or already-seeded) rows in it, so this can never
   overwrite anything you typed in by hand. Set SEED=0 to skip it entirely
   and start truly empty.

   Covers one of each order status, a website order and a WhatsApp one, and
   parcels in every state the parcels page knows how to show: delivered,
   still moving, tied to nothing with a phone that matches no order, and one
   coming back (RTO) — so every screen has something real on it the moment
   this starts, without placing a single test order by hand first. */
function seedMockData(sqlite) {
  if (process.env.SEED === "0") return false;
  const had = sqlite.prepare("SELECT COUNT(*) AS n FROM orders").get().n;
  if (had > 0) return false;

  const ist = 5.5 * 3600e3;
  const stamp = (() => {
    const d = new Date(Date.now() + ist);
    return String(d.getUTCFullYear()).slice(2) + String(d.getUTCMonth() + 1).padStart(2, "0");
  })();
  const ref = n => `Q-${stamp}-${String(n).padStart(2, "0")}`;
  const ago = (days, hours = 0) => new Date(Date.now() - days * 86400e3 - hours * 3600e3).toISOString();

  const insOrder = sqlite.prepare(`INSERT INTO orders
    (ref, placed_at, name, phone, pincode, address, pay, poth, items,
     goods, shipping, cod_fee, total, status, note, source, photo, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  const orders = [
    {n: 1, name: "Manisha Deshmukh", phone: "9812345671", pincode: "411015",
     address: "Flat 4, Om Sai Society, Dighi Road", pay: "cod", poth: "32",
     items: [{code: "TH-108", title: "Rajwadi Thushi — 9 line", qty: 1, price: 2850, size: "32"}],
     goods: 2850, shipping: 0, cod_fee: 200, total: 3050,
     status: "new", note: "Please pack in a gift box", source: "site", when: ago(0, 2)},
    {n: 2, name: "Aparna Joshi", phone: "9823456782", pincode: "411001",
     address: "12 Ganesh Nagar, Bopodi", pay: "online", poth: "30",
     items: [{code: "MS-204", title: "Kolhapuri Mangalsutra", qty: 1, price: 1899, size: "30"}],
     goods: 1899, shipping: 0, cod_fee: 0, total: 1899,
     status: "confirmed", note: "", source: "site", when: ago(1, 5)},
    {n: 3, name: "Komal Shinde", phone: "9834567893", pincode: "411028",
     address: "7 Shivaji Housing Society, Vishrantwadi", pay: "cod", poth: "",
     items: [{code: "NT-311", title: "Nath — Peshwai gold-tone", qty: 2, price: 650}],
     goods: 1300, shipping: 79, cod_fee: 200, total: 1579,
     status: "sent", note: "", source: "site", when: ago(4, 1)},
    {n: 4, name: "Trupti More", phone: "9845678904", pincode: "440001",
     address: "22 Sitabuldi Main Road", pay: "online", poth: "34",
     items: [{code: "KM-227", title: "Bridal Kambarpatta set", qty: 1, price: 4200, size: "34"}],
     goods: 4200, shipping: 0, cod_fee: 0, total: 4200,
     status: "done", note: "", source: "site", when: ago(6, 0)},
    {n: 5, name: "Revati Kulkarni", phone: "9856789015", pincode: "411057",
     address: "5 Wadgaon Sheri", pay: "online", poth: "",
     items: [{code: "OFFLINE", title: "Nauvari-style Bugadi", qty: 1, price: 1600}],
     goods: 1600, shipping: 0, cod_fee: 0, total: 1600,
     status: "confirmed", note: "Agreed on WhatsApp, 27 Aug", source: "whatsapp", when: ago(2, 3)},
    {n: 6, name: "Nikita Bhosale", phone: "9867890126", pincode: "",
     address: "", pay: "shop", poth: "",
     items: [{code: "BG-119", title: "Bugadi — traditional gold-tone", qty: 1, price: 950}],
     goods: 950, shipping: 0, cod_fee: 0, total: 950,
     status: "cancelled", note: "Changed her mind", source: "site", when: ago(7, 4)}
  ];
  for (const o of orders) {
    insOrder.run(ref(o.n), o.when, o.name, o.phone, o.pincode, o.address, o.pay, o.poth,
      JSON.stringify(o.items), o.goods, o.shipping, o.cod_fee, o.total, o.status, o.note,
      o.source, "", o.when);
  }

  const insParcel = sqlite.prepare(`INSERT INTO parcels
    (awb, who, added_at, booked_at, from_c, to_c, status, moves, done, asked_at, ref, phone)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);

  const parcels = [
    /* Tied to order 3 — still on its way. */
    {awb: "1741000001", who: "Komal Shinde", added: ago(3, 22), booked: ago(3, 20),
     from_c: "Dighi, Pune", to_c: "Vishrantwadi, Pune", status: "OUT FOR DELIVERY",
     moves: [{at: ago(3, 20), what: "Picked up", where: "Dighi, Pune"},
             {at: ago(2, 10), what: "In transit", where: "Pune hub", to: "Vishrantwadi hub"},
             {at: ago(1, 6),  what: "Out for delivery", where: "Vishrantwadi hub"}],
     done: 0, asked: ago(1, 6), ref: ref(3), phone: "9834567893"},
    /* Tied to order 4 — delivered. */
    {awb: "1741000002", who: "Trupti More", added: ago(5, 22), booked: ago(5, 20),
     from_c: "Dighi, Pune", to_c: "Sitabuldi, Nagpur", status: "DELIVERED",
     moves: [{at: ago(5, 20), what: "Picked up", where: "Dighi, Pune"},
             {at: ago(4, 12), what: "In transit", where: "Pune hub", to: "Nagpur hub"},
             {at: ago(3, 2),  what: "Delivered", where: "Sitabuldi, Nagpur"}],
     done: 1, asked: ago(3, 2), ref: ref(4), phone: "9845678904"},
    /* Written down with a number, but it matches no order of hers — shows
       the "matched no order" message and the tie-by-hand box. */
    {awb: "1741000003", who: "Priyanka Gaikwad", added: ago(2, 6), booked: ago(2, 4),
     from_c: "Dighi, Pune", to_c: "Kothrud, Pune", status: "IN TRANSIT",
     moves: [{at: ago(2, 4), what: "Picked up", where: "Dighi, Pune"}],
     done: 0, asked: ago(0, 10), ref: "", phone: "9878901237"},
    /* No number at all, and coming back — the red "coming back" row. */
    {awb: "1741000004", who: "Sonali Jadhav", added: ago(6, 3), booked: ago(6, 1),
     from_c: "Dighi, Pune", to_c: "Hadapsar, Pune", status: "RTO INITIATED — customer refused",
     moves: [{at: ago(6, 1), what: "Picked up", where: "Dighi, Pune"},
             {at: ago(5, 10), what: "RTO initiated", where: "Hadapsar hub"}],
     done: 0, asked: ago(5, 10), ref: "", phone: ""}
  ];
  for (const p of parcels) {
    insParcel.run(p.awb, p.who, p.added, p.booked, p.from_c, p.to_c, p.status,
      JSON.stringify(p.moves), p.done, p.asked, p.ref, p.phone);
  }

  /* A fortnight of visit counts, rising toward today; how far those visits
     got — past the first page, as far as the order page; and a few days of
     the how-to film's numbers — so /office/visits/ has something to draw
     the moment it is opened instead of an empty room. Kept roughly honest
     relative to each other: browsed ≤ visit, order_page ≤ browsed, same
     shape the real numbers will have. */
  const insTally = sqlite.prepare(`INSERT INTO tally (day, what, n) VALUES (?,?,?)
    ON CONFLICT(day, what) DO UPDATE SET n = n + excluded.n`);
  const dayKey = daysAgo => new Date(Date.now() - daysAgo * 86400e3).toISOString().slice(0, 10);
  const seedRow = (what, counts) =>
    counts.forEach((n, i) => insTally.run(dayKey(counts.length - 1 - i), what, n));

  seedRow("visit",      [3, 5, 4, 7, 9, 6, 8, 11, 7, 10, 13, 9, 12, 6]);  // 13 days ago .. today
  seedRow("browsed",    [2, 3, 3, 5, 6, 4, 6,  8, 5,  7,  9, 6,  8, 4]);
  seedRow("order_page", [1, 2, 1, 3, 4, 2, 3,  5, 3,  4,  6, 4,  5, 2]);
  [["howto_shown", 22], ["howto_open", 15], ["howto_half", 9], ["howto_finished", 6]]
    .forEach(([what, n]) => insTally.run(dayKey(2), what, n));

  return true;
}

/* A file, so orders survive a restart. Some folders cannot hold a SQLite
   file — a network drive, OneDrive, a shared folder — so fall back to
   memory rather than refusing to start. */
let sqlite, kept = DBFILE;
try {
  sqlite = ready(new DatabaseSync(DBFILE));
} catch (err) {
  sqlite = ready(new DatabaseSync(":memory:"));
  kept = null;
}
const justSeeded = seedMockData(sqlite);

const DB = {
  prepare(sql) {
    const make = args => ({
      bind: (...a) => make(a),
      async first() { const r = sqlite.prepare(sql).get(...args); return r ? {...r} : null; },
      async all()   { return {results: sqlite.prepare(sql).all(...args).map(r => ({...r}))}; },
      async run()   { const r = sqlite.prepare(sql).run(...args);
                      return {success: true, meta: {changes: Number(r.changes || 0)}}; }
    });
    return make([]);
  }
};

/* ---------- the files of the site ---------- */

const TYPES = {
  ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8",
  ".css":"text/css; charset=utf-8",   ".json":"application/json; charset=utf-8",
  ".xml":"application/xml; charset=utf-8", ".txt":"text/plain; charset=utf-8",
  ".svg":"image/svg+xml", ".jpg":"image/jpeg", ".jpeg":"image/jpeg", ".png":"image/png",
  ".webp":"image/webp",   ".gif":"image/gif",  ".ico":"image/x-icon",
  ".mp4":"video/mp4",     ".webm":"video/webm", ".woff2":"font/woff2", ".txt":"text/plain"
};

const ASSETS = {
  async fetch(request) {
    let p = decodeURIComponent(new URL(request.url).pathname);

    /* The studio is a different server on a different port. This one has no
       studio API and no GitHub token, so the studio opened here would find
       nothing to show and nothing to write to. Sent next door instead. */
    if (/^\/(admin\.html|studio\/?(index\.html)?)$/i.test(p)) return new Response(
      `<!doctype html><meta charset=utf-8>
       <title>Wrong window</title>
       <style>body{font:16px/1.6 system-ui;max-width:34rem;margin:16vh auto;padding:0 6vw;
       background:#FAF3EB;color:#2A1A14}a{color:#7E1226}code{background:#F1E5D6;padding:1px 5px;
       border-radius:4px}</style>
       <h1 style="font-weight:400">The studio lives next door</h1>
       <p>This window is the order side — the shop, the order form and the order book.
       It has no studio API and no GitHub token, so the studio opened here would show
       no categories and no pieces, and would have nowhere to save anything.</p>
       <p>Run <code>preview.bat</code> instead and open
       <a href="http://localhost:8000/studio/">localhost:8000/studio/</a>. That writes
       straight into the folder on this computer.</p>`,
      {status: 409, headers: {"content-type": "text/html; charset=utf-8"}});

    if (p.endsWith("/")) p += "index.html";
    if (p === "") p = "/index.html";
    let file = path.join(ROOT, p);
    /* Cloudflare serves /office/new from /office/new/index.html. Do the same,
       so a link without the closing slash works here too. */
    if (fs.existsSync(file) && fs.statSync(file).isDirectory())
      file = path.join(file, "index.html");
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory())
      return new Response("Not found", {status: 404});
    /* Content-Length and a word that ranges are understood. Cloudflare sends
       both; without them a browser will not play a video at all — it asks for
       a byte range, gets a chunked reply with no length, and gives up with
       "no supported sources", which looks exactly like a broken file. */
    const body = fs.readFileSync(file);
    return new Response(body, {
      headers: {
        "content-type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
        "content-length": String(body.length),
        "accept-ranges": "bytes"
      }
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
    a new order     http://localhost:${PORT}/office/new/
    parcels         http://localhost:${PORT}/office/parcels/
    track an order  http://localhost:${PORT}/my/   (try 98123 45671)

    password        ${PASSWORD}
    numbers         90112 40352 · 75582 09163 · 95796 28754

    database        ${kept
      ? `.qala-dev.sqlite  (${rows} order${rows === 1 ? "" : "s"} so far)
                    delete that file for a clean start`
      : `in memory only — this folder cannot hold a database file,
                    so orders will disappear when you stop this`}
    ${justSeeded
      ? `mock data       6 orders, 4 parcels, one of each status — put in\n                    automatically because the book was empty. Set SEED=0\n                    to start truly blank instead, or just delete\n                    .qala-dev.sqlite whenever you want a clean start.`
      : ""}

  Ctrl+C to stop.
`);
});
