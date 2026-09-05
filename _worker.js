/* ---------------------------------------------------------------------------
   The Qala — the small piece of the site that runs on Cloudflare's side.

   Everything else here is plain files. This one file adds:

     POST /api/order      the website records an order after WhatsApp opens
     GET  /api/stock      what is still available in each size            (public)
     POST /office/login   you sign in                          (public)
     POST /office/logout  you sign out
     GET  /office/api     the order book reads them back       (signed in only)
     POST /office/api     the order book changes a status      (signed in only)
     /studio*             the studio, once it is hosted        (signed in only)

   Orders live in a D1 database bound to this project under the name DB.
   If that binding is missing, or the database is asleep, the order still
   goes through on WhatsApp — the site never waits for this file.

   Anything that is not one of those paths is served exactly as before,
   straight from the files in this repository.
--------------------------------------------------------------------------- */

/* Kept the same as the top of index.html. If shipping ever changes, change
   it in both places — the website shows the total, this recomputes it. */
const SHIP_FREE_OVER = 1499;
const SHIP_FLAT      = 79;
const COD_EXTRA      = 200;

/* Poth lengths the shop offers, in inches. Same list as the order form. */
const POTH = ["24", "26", "28", "30", "32", "34", "36", "38", "40"];

/* A size is held the moment somebody orders it, but an order is only an
   intent — most of the work happens on WhatsApp afterwards. So a hold on an
   order still sitting at "new" lets go by itself after this long, and the size
   comes back. Marking the order confirmed makes the hold permanent. */
const HOLD_HOURS = 24;
const HOLDS_FOREVER = ["confirmed", "sent", "done"];   // cancelled releases at once

/* Flood guards. Generous for a real shop, tight enough to stop a script. */
const MAX_PER_PHONE_PER_DAY = 8;
const MAX_PER_MINUTE        = 20;
const MAX_ITEMS             = 20;

/* Who may open the order book. The password is NOT here — it lives on the
   project as STUDIO_PASSWORD, so it never reaches anybody's browser. */
const STAFF = ["9011240352", "7558209163", "9579628754"];

const COOKIE       = "qala_session";
const SESSION_DAYS = 30;
const MAX_LOGIN_FAILS = 10;     // per address, per quarter of an hour

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";

      if (path === "/api/order"     && request.method === "POST") return takeOrder(request, env);
      if (path === "/api/stock"     && request.method === "GET")  return stockNow(request, env);
      if (path === "/office/login"  && request.method === "POST") return login(request, env);
      if (path === "/office/logout" && request.method === "POST") return logout();
      if (path === "/office/api")                                 return officeApi(request, env, url);

      /* The studio, when it is hosted, is never handed out unsigned-in. */
      if (path === "/studio" || path.startsWith("/studio/")) {
        const who = await whoGoes(request, env);
        if (!who.ok) return Response.redirect(
          url.origin + "/office/?next=" + encodeURIComponent(url.pathname + url.search), 302);
      }

      return env.ASSETS.fetch(request);
    } catch (err) {
      /* A bug in here must never take the shop down. */
      try { return await env.ASSETS.fetch(request); }
      catch { return new Response("Temporarily unavailable", {status: 503}); }
    }
  }
};

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: Object.assign(
      {"content-type": "application/json; charset=utf-8", "cache-control": "no-store"}, extra)
  });

/* ===========================================================================
   Writing an order
   ===========================================================================
   This is open to the whole internet, so nothing it is sent is trusted.
   A row here means "somebody filled in the form", not "an order is confirmed".
   The WhatsApp message is still what makes an order real.
*/
async function takeOrder(request, env) {
  if (!env.DB) return json({ok: false, stored: false, why: "no database"}, 200);

  let body;
  try { body = await request.json(); }
  catch { return json({ok: false, stored: false, why: "bad body"}, 400); }

  const o = clean(body);
  if (o.error) return json({ok: false, stored: false, why: o.error}, 400);

  try {
    /* Two cheap counts before writing, both on indexed columns. */
    const dayAgo    = new Date(Date.now() - 24 * 3600e3).toISOString();
    const minuteAgo = new Date(Date.now() - 60e3).toISOString();

    const mine = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM orders WHERE phone = ? AND placed_at > ?"
    ).bind(o.phone, dayAgo).first();
    if (mine && mine.n >= MAX_PER_PHONE_PER_DAY)
      return json({ok: false, stored: false, why: "too many today"}, 429);

    const all = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM orders WHERE placed_at > ?"
    ).bind(minuteAgo).first();
    if (all && all.n >= MAX_PER_MINUTE)
      return json({ok: false, stored: false, why: "busy"}, 429);

    /* Two people can reach the last one at the same moment. The page greys out
       what it knew about; this is the check that actually decides. */
    const gone = await soldOut(env, o.items);
    if (gone.length)
      return json({ok: false, stored: false, why: "size gone", gone}, 409);

    /* OR IGNORE, so a customer who taps twice does not make two rows. */
    await env.DB.prepare(
      `INSERT OR IGNORE INTO orders
       (ref, placed_at, name, phone, pincode, address, pay, poth, items,
        goods, shipping, cod_fee, total, status, note, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'new','',?)`
    ).bind(
      o.ref, o.placed_at, o.name, o.phone, o.pincode, o.address, o.pay, o.poth,
      JSON.stringify(o.items), o.goods, o.shipping, o.cod_fee, o.total, o.placed_at
    ).run();

    return json({ok: true, stored: true, ref: o.ref});
  } catch (err) {
    /* Database trouble is our problem, not the customer's. */
    return json({ok: false, stored: false, why: "write failed"}, 200);
  }
}

/* Everything the form can send, checked and rebuilt from scratch. */
function clean(b) {
  const s = (v, max) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);

  const ref = s(b.ref, 32);
  if (!/^QALA-\d{4}-\d{4}$/.test(ref)) return {error: "ref"};

  const name = s(b.name, 80);
  if (name.length < 2) return {error: "name"};

  const phone = String(b.phone || "").replace(/\D/g, "").slice(-10);
  if (!/^[6-9]\d{9}$/.test(phone)) return {error: "phone"};

  const pay = ["online", "shop", "cod"].includes(b.pay) ? b.pay : null;
  if (!pay) return {error: "pay"};

  /* Optional — most pieces do not need one, and it can be settled in the chat. */
  const poth = s(b.poth, 4);
  if (poth && !POTH.includes(poth)) return {error: "poth"};

  const pickup  = pay === "shop";
  const pincode = pickup ? "" : String(b.pin || "").replace(/\D/g, "").slice(0, 6);
  const address = pickup ? "" : s(b.addr, 400);
  if (!pickup && !/^\d{6}$/.test(pincode)) return {error: "pincode"};
  if (!pickup && address.length < 12)      return {error: "address"};

  if (!Array.isArray(b.items) || !b.items.length || b.items.length > MAX_ITEMS)
    return {error: "items"};

  const items = [];
  for (const l of b.items) {
    const code  = s(l && l.code, 24);
    const title = s(l && l.title, 120);
    const qty   = Math.floor(Number(l && l.qty));
    const price = Math.floor(Number(l && l.price));
    if (!code || !Number.isFinite(qty) || qty < 1 || qty > 50) return {error: "item qty"};
    if (!Number.isFinite(price) || price < 0 || price > 5000000) return {error: "item price"};
    const size = s(l && l.size, 4);
    if (size && !POTH.includes(size)) return {error: "item size"};
    items.push(size ? {code, title, qty, price, size} : {code, title, qty, price});
  }

  /* Totals are recomputed here. Whatever the browser said is ignored. */
  const goods    = items.reduce((a, l) => a + l.price * l.qty, 0);
  const shipping = pickup ? 0 : (goods >= SHIP_FREE_OVER ? 0 : SHIP_FLAT);
  const cod_fee  = pay === "cod" ? COD_EXTRA : 0;

  return {
    ref, placed_at: new Date().toISOString(), name, phone, pincode, address,
    pay, poth, items, goods, shipping, cod_fee, total: goods + shipping + cod_fee
  };
}

/* ===========================================================================
   What is still available
   ===========================================================================
   There is no second set of books. How many of a size are spoken for is worked
   out from the orders themselves every time, so it can never drift away from
   what the order book shows.

   An order holds a size while it is confirmed, sent or done — or while it is
   still new and less than a day old. Cancel an order and the size is free at
   once; ignore one and it frees itself.
*/
async function heldNow(env) {
  const held = {};                                    // {"NECKLACE-01": {"28": 2}}
  if (!env.DB) return held;

  const cutoff = new Date(Date.now() - HOLD_HOURS * 3600e3).toISOString();
  const marks = HOLDS_FOREVER.map(() => "?").join(",");
  /* Narrowed by status and date only. A row's sizes may be on the order or on
     each piece, so which rows matter is decided below, not in SQL. */
  const {results} = await env.DB.prepare(
    `SELECT items, poth FROM orders
      WHERE status IN (${marks}) OR (status = 'new' AND placed_at > ?)`
  ).bind(...HOLDS_FOREVER, cutoff).all();

  for (const row of results || []) {
    let items;
    try { items = JSON.parse(row.items) || []; } catch { continue; }
    for (const it of items) {
      /* The size the customer chose for this line, or the order's own if the
         order was placed before sizes were kept per piece. */
      const size = String(it.size || row.poth || "");
      if (!size || !it.code) continue;
      held[it.code] = held[it.code] || {};
      held[it.code][size] = (held[it.code][size] || 0) + (Number(it.qty) || 1);
    }
  }
  return held;
}

/* How many of each size were made. That lives with the piece, in the
   catalogue the site already publishes, so there is nothing extra to keep
   in step. Held briefly in memory because it only changes on a deploy. */
let OPENING = null, OPENING_AT = 0;

async function openingStock(env) {
  if (OPENING && Date.now() - OPENING_AT < 300e3) return OPENING;
  const out = {};
  try {
    const res = await env.ASSETS.fetch(new Request("https://qala.local/photos/catalogue.json"));
    if (res.ok) {
      const cat = await res.json();
      for (const c of cat.categories || [])
        for (const p of c.products || [])
          if (p.sizes && Object.keys(p.sizes).length) out[p.code] = p.sizes;
    }
  } catch { /* no catalogue is the same as no sizes anywhere */ }
  OPENING = out; OPENING_AT = Date.now();
  return out;
}

/* Sizes on this order that somebody else has already taken. */
async function soldOut(env, items) {
  const sized = items.filter(i => i.size);
  if (!sized.length) return [];

  const [opening, held] = await Promise.all([openingStock(env), heldNow(env)]);
  const gone = [];
  const mine = {};
  for (const it of sized) {
    const made = (opening[it.code] || {})[it.size];
    if (made == null) continue;               // the piece has no sizes; nothing to count
    mine[it.code] = mine[it.code] || {};
    mine[it.code][it.size] = (mine[it.code][it.size] || 0) + it.qty;
    const taken = ((held[it.code] || {})[it.size] || 0) + mine[it.code][it.size];
    if (taken > made) gone.push({code: it.code, size: it.size});
  }
  return gone;
}

async function stockNow(request, env) {
  const held = await heldNow(env);
  return json({ok: true, held, holdHours: HOLD_HOURS}, 200,
    /* Half a minute is short enough that a sold-out size greys out promptly,
       long enough that a busy evening does not hammer the database. */
    {"cache-control": "public, max-age=30"});
}

/* ===========================================================================
   Signing in
   ===========================================================================
   The password is compared here, on Cloudflare's side. It is never written
   into any page, so nobody can read it out of the source. What the browser
   gets back is a signed ticket that says only "this number, until this date"
   — it cannot be edited into somebody else's, and it cannot be made up.
*/
async function login(request, env) {
  const secret = env.STUDIO_PASSWORD;
  if (!secret) return json({ok: false, why:
    "No password has been set on this project yet. Add STUDIO_PASSWORD under Settings → Variables."}, 503);

  let b;
  try { b = await request.json(); } catch { return json({ok: false, why: "bad body"}, 400); }

  const phone = String(b.phone || "").replace(/\D/g, "").slice(-10);
  const given = String(b.password || "");
  const ip    = request.headers.get("CF-Connecting-IP") || "unknown";

  if (await tooManyTries(env, ip))
    return json({ok: false, why: "Too many wrong tries. Wait fifteen minutes and try again."}, 429);

  const known = STAFF.includes(phone) && await sameSecret(given, secret);
  await noteTry(env, ip, phone, known);
  if (!known) return json({ok: false, why: "That number and password do not match."}, 401);

  const token = await makeTicket(phone, secret);
  return json({ok: true, you: pretty(phone)}, 200, {"set-cookie": cookie(token, SESSION_DAYS * 86400)});
}

const logout = () => json({ok: true}, 200, {"set-cookie": cookie("", 0)});

const cookie = (v, age) =>
  `${COOKIE}=${v}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;

const pretty = p => p.slice(0, 5) + " " + p.slice(5);

/* Compared as digests of the same length, end to end, so how quickly this
   returns says nothing about how much of the password was right. */
async function sameSecret(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b))
  ]);
  const p = new Uint8Array(x), q = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < p.length; i++) diff |= p[i] ^ q[i];
  return diff === 0;
}

/* The signing key comes from the password itself, so changing the password
   signs everybody out at once. One secret to set, not two. */
async function ticketKey(secret) {
  const raw = await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(secret + "|qala-session-v1"));
  return crypto.subtle.importKey("raw", raw, {name: "HMAC", hash: "SHA-256"}, false, ["sign"]);
}

async function makeTicket(phone, secret) {
  const payload = b64(new TextEncoder().encode(JSON.stringify(
    {u: phone, exp: Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400})));
  const key = await ticketKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return payload + "." + b64(new Uint8Array(sig));
}

async function readTicket(token, secret) {
  const bits = String(token || "").split(".");
  if (bits.length !== 2) return null;

  const key = await ticketKey(secret);
  const want = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(bits[0])));
  let got;
  try { got = unb64(bits[1]); } catch { return null; }
  if (got.length !== want.length) return null;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want[i] ^ got[i];
  if (diff !== 0) return null;

  let body;
  try { body = JSON.parse(new TextDecoder().decode(unb64(bits[0]))); } catch { return null; }
  if (!body || !STAFF.includes(body.u)) return null;
  if (typeof body.exp !== "number" || body.exp < Math.floor(Date.now() / 1000)) return null;
  return body.u;
}

function cookieValue(request, name) {
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}

/* Wrong passwords are counted per address, so the shared password cannot be
   guessed at by a machine. Best effort — if the database is away, sign-in
   still works rather than locking the shop out of its own orders. */
async function tooManyTries(env, ip) {
  if (!env.DB) return false;
  try {
    const since = new Date(Date.now() - 15 * 60e3).toISOString();
    const r = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM logins WHERE ip = ? AND ok = 0 AND at > ?"
    ).bind(ip, since).first();
    return !!(r && r.n >= MAX_LOGIN_FAILS);
  } catch { return false; }
}

async function noteTry(env, ip, phone, ok) {
  if (!env.DB) return;
  try {
    await env.DB.prepare("INSERT INTO logins (at, ip, phone, ok) VALUES (?,?,?,?)")
      .bind(new Date().toISOString(), ip, phone, ok ? 1 : 0).run();
    /* Keep the table from growing forever. */
    await env.DB.prepare("DELETE FROM logins WHERE at < ?")
      .bind(new Date(Date.now() - 24 * 3600e3).toISOString()).run();
  } catch { /* not worth failing a sign-in over */ }
}

/* Either way in: the password ticket, or Cloudflare Access if it is set up. */
async function whoGoes(request, env) {
  if (env.STUDIO_PASSWORD) {
    const who = await readTicket(cookieValue(request, COOKIE), env.STUDIO_PASSWORD);
    if (who) return {ok: true, who: pretty(who), how: "password"};
  }
  const acc = await accessUser(request, env);
  if (acc.ok) return {ok: true, who: acc.email, how: "access"};

  return {ok: false, why: env.STUDIO_PASSWORD
    ? "Sign in to open the order book."
    : "No password has been set on this project yet. Add STUDIO_PASSWORD under Settings → Variables."};
}

/* ===========================================================================
   Reading the order book
   ===========================================================================
   This holds customers' names, numbers and home addresses, so it refuses
   every request that cannot prove who it is. If nothing has been set up yet,
   it refuses everything — including you. That is deliberate: the wrong way
   round would leave your customers exposed.
*/
async function officeApi(request, env, url) {
  const who = await whoGoes(request, env);
  if (!who.ok) return json({ok: false, login: true, why: who.why}, 401);
  if (!env.DB)  return json({ok: false, why: "The DB binding is not attached to this project yet."}, 503);

  if (request.method === "GET")  return listOrders(env, url, who.who);
  if (request.method === "POST") return updateOrder(request, env);
  return json({ok: false, why: "method"}, 405);
}

async function listOrders(env, url, who) {
  const status = url.searchParams.get("status") || "";
  const q      = (url.searchParams.get("q") || "").trim();
  const limit  = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "200", 10) || 200, 1), 1000);

  let sql = "SELECT * FROM orders", where = [], bind = [];
  if (status && status !== "all") { where.push("status = ?"); bind.push(status); }
  if (q) {
    where.push("(ref LIKE ? OR name LIKE ? OR phone LIKE ?)");
    const like = "%" + q.replace(/[%_]/g, "") + "%";
    bind.push(like, like, like);
  }
  if (where.length) sql += " WHERE " + where.join(" AND ");
  sql += " ORDER BY placed_at DESC LIMIT ?";
  bind.push(limit);

  const {results} = await env.DB.prepare(sql).bind(...bind).all();
  const rows = (results || []).map(r => ({...r, items: safeItems(r.items)}));

  if (url.searchParams.get("format") === "csv") {
    return new Response(toCsv(rows), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="qala-orders-${new Date().toISOString().slice(0, 10)}.csv"`,
        "cache-control": "no-store"
      }
    });
  }

  const counts = await env.DB.prepare(
    "SELECT status, COUNT(*) AS n FROM orders GROUP BY status"
  ).all();

  return json({ok: true, you: who, orders: rows, counts: counts.results || []});
}

async function updateOrder(request, env) {
  let b;
  try { b = await request.json(); } catch { return json({ok: false, why: "bad body"}, 400); }

  const ref = String(b.ref || "");
  if (!/^QALA-\d{4}-\d{4}$/.test(ref)) return json({ok: false, why: "ref"}, 400);

  const allowed = ["new", "confirmed", "sent", "done", "cancelled"];
  const sets = [], bind = [];
  if (b.status != null) {
    if (!allowed.includes(b.status)) return json({ok: false, why: "status"}, 400);
    sets.push("status = ?"); bind.push(b.status);
  }
  if (b.note != null) { sets.push("note = ?"); bind.push(String(b.note).slice(0, 500)); }
  if (b.poth != null) {
    const p = String(b.poth).trim();
    if (p && !POTH.includes(p)) return json({ok: false, why: "poth"}, 400);
    sets.push("poth = ?"); bind.push(p);
  }
  if (!sets.length) return json({ok: false, why: "nothing to change"}, 400);

  sets.push("updated_at = ?"); bind.push(new Date().toISOString());
  bind.push(ref);

  await env.DB.prepare(`UPDATE orders SET ${sets.join(", ")} WHERE ref = ?`).bind(...bind).run();
  const row = await env.DB.prepare("SELECT * FROM orders WHERE ref = ?").bind(ref).first();
  if (!row) return json({ok: false, why: "not found"}, 404);
  return json({ok: true, order: {...row, items: safeItems(row.items)}});
}

const safeItems = s => { try { return JSON.parse(s) || []; } catch { return []; } };

function toCsv(rows) {
  const head = ["ref", "placed_at", "status", "name", "phone", "pincode", "address",
                "pay", "poth", "pieces", "goods", "shipping", "cod_fee", "total", "note"];
  const cell = v => {
    const s = v == null ? "" : String(v);
    /* A leading =, +, - or @ is how a spreadsheet gets tricked into running
       something. Prefix it so Excel treats the cell as plain text. */
    const safe = /^[=+\-@]/.test(s) ? "'" + s : s;
    return /[",\n]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
  };
  const line = r => [
    r.ref, r.placed_at, r.status, r.name, "'" + r.phone, r.pincode, r.address, r.pay,
    r.poth ? r.poth + " in" : "",
    r.items.map(i => `${i.code} x${i.qty}`).join(" | "),
    r.goods, r.shipping, r.cod_fee, r.total, r.note
  ].map(cell).join(",");
  return "﻿" + [head.join(","), ...rows.map(line)].join("\r\n");
}

/* ===========================================================================
   Cloudflare Access — the other way in, if it is ever switched on
   ===========================================================================
   Access puts a signed token on every request it lets through. We check that
   signature against your team's public keys — a copied header will not pass.

   Needs two variables on the project (Settings → Variables):
     ACCESS_TEAM   your team name, the bit before .cloudflareaccess.com
     ACCESS_AUD    the Application Audience tag of the Access application
*/
let CERTS = null, CERTS_AT = 0;

async function accessUser(request, env) {
  const team = env.ACCESS_TEAM, aud = env.ACCESS_AUD;
  if (!team || !aud) return {ok: false, why: "Access is not set up."};

  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return {ok: false, why: "No Access token on this request."};

  const bits = token.split(".");
  if (bits.length !== 3) return {ok: false, why: "Malformed token."};

  let head, body;
  try {
    head = JSON.parse(new TextDecoder().decode(unb64(bits[0])));
    body = JSON.parse(new TextDecoder().decode(unb64(bits[1])));
  } catch { return {ok: false, why: "Malformed token."}; }

  if (head.alg !== "RS256") return {ok: false, why: "Unexpected signature type."};

  const now = Math.floor(Date.now() / 1000);
  if (typeof body.exp !== "number" || body.exp < now) return {ok: false, why: "Token expired."};
  if (typeof body.nbf === "number" && body.nbf > now + 60) return {ok: false, why: "Token not valid yet."};
  if (body.iss !== `https://${team}.cloudflareaccess.com`) return {ok: false, why: "Token is for another team."};

  const auds = Array.isArray(body.aud) ? body.aud : [body.aud];
  if (!auds.includes(aud)) return {ok: false, why: "Token is for another application."};

  let jwks;
  try { jwks = await certs(team); } catch { return {ok: false, why: "Could not reach Access."}; }

  const jwk = jwks.find(k => k.kid === head.kid);
  if (!jwk) return {ok: false, why: "Token signed with an unknown key."};

  const key = await crypto.subtle.importKey(
    "jwk", {kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true},
    {name: "RSASSA-PKCS1-v1_5", hash: "SHA-256"}, false, ["verify"]
  );
  const good = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key, unb64(bits[2]),
    new TextEncoder().encode(bits[0] + "." + bits[1])
  );
  if (!good) return {ok: false, why: "Signature did not check out."};

  return {ok: true, email: body.email || body.common_name || "someone"};
}

async function certs(team) {
  if (CERTS && Date.now() - CERTS_AT < 3600e3) return CERTS;
  const r = await fetch(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error("certs " + r.status);
  const j = await r.json();
  if (!j.keys || !j.keys.length) throw new Error("no keys");
  CERTS = j.keys; CERTS_AT = Date.now();
  return CERTS;
}

const b64 = bytes => btoa(String.fromCharCode(...bytes))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const unb64 = s => Uint8Array.from(
  atob(String(s).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(s).length + 3) % 4)),
  c => c.charCodeAt(0)
);
