/* ---------------------------------------------------------------------------
   The Qala — the small piece of the site that runs on Cloudflare's side.

   Everything else here is plain files. This one file adds:

     POST /api/order      the website records an order after WhatsApp opens
     GET  /api/stock      how many of each piece are spoken for      (public)
     POST /office/login   you sign in                          (public)
     POST /office/logout  you sign out
     GET  /office/api     the order book reads them back       (signed in only)
     POST /office/api     the order book changes a status      (signed in only)
     /office/gh/*         the studio's way to GitHub           (signed in only)
     /studio*             the studio itself                    (signed in only)

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

/* A piece is held the moment somebody orders it. But an order is only an
   intent — the real conversation happens on WhatsApp afterwards — so a hold on
   an order still sitting at "new" lets go by itself after this long, and the
   piece comes back. Marking it confirmed makes the hold permanent.

   Without that, anybody could empty the shop by filling in the form a few
   times, and every abandoned order would lock a piece up for ever. */
const HOLD_HOURS = 24;
const HOLDS_FOREVER = ["confirmed", "sent", "done"];   // cancelled frees it at once

/* Flood guards. Generous for a real shop, tight enough to stop a script. */
const MAX_PER_PHONE_PER_DAY = 8;
const MAX_PER_MINUTE        = 20;
const MAX_ITEMS             = 20;

/* Where an order came from. "site" is the website itself and is the only one
   that counts against how many of a piece are left — see takenNow below.
   Everything else was typed in by the shop, which set the piece aside by hand
   the moment it answered the chat. */
const SOURCES = ["whatsapp", "instagram", "phone", "shop"];
const SOURCENAME = {whatsapp: "WhatsApp", instagram: "Instagram",
                    phone: "a phone call", shop: "the shop"};

/* A photograph from a chat, already shrunk in the browser before it is sent.
   Base64 characters, so about three quarters of this in real bytes — roughly
   one megabyte, well inside what a single D1 row will hold. */
const MAX_PHOTO_CHARS = 1400000;

/* How long a tab counts as "here" after it last said hello. The shop says
   hello every 45 seconds while it is the tab you are looking at, so two
   minutes leaves room for a slow phone without holding on to people who
   have gone. */
const HERE_MINUTES = 2;
const HERE_SWEEP_AFTER = 10;      // minutes, before a row is thrown away

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
      if (path === "/api/ref"       && request.method === "GET")  return peekRef(env);
      if (path === "/api/here"      && request.method === "POST") return whoIsHere(request, env);
      if (path === "/office/login"  && request.method === "POST") return login(request, env);
      if (path === "/office/logout" && request.method === "POST") return logout();
      if (path === "/office/api")                                 return officeApi(request, env, url);
      if (path.startsWith("/office/gh/"))                         return toGitHub(request, env, path);
      if (path === "/api/chat-order" && request.method === "POST") return chatOrder(request, env);
      if (path === "/office/order"  && request.method === "POST") return newOrder(request, env);
      if (path.startsWith("/office/img/") && request.method === "GET")
                                                                  return photoOut(request, env, path);

      /* The studio and the office's order form are never handed out
         unsigned-in. Everything they can do is checked again on the way in
         below — this only saves showing a page to somebody who cannot use it. */
      if (path === "/studio" || path.startsWith("/studio/") || path === "/office/new") {
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

    /* The same order can reach us twice: the page sends it as she leaves, and
       the copy the browser kept can arrive after. Two rows for one tap would
       hold two pieces and take two numbers, so an order that matches one taken
       in the last few minutes is answered with that one instead of written again. */
    const items = JSON.stringify(o.items);
    const twin = await env.DB.prepare(
      `SELECT ref FROM orders WHERE phone = ? AND total = ? AND items = ? AND placed_at > ?
       ORDER BY placed_at DESC LIMIT 1`
    ).bind(o.phone, o.total, items, new Date(Date.now() - 5 * 60e3).toISOString()).first();
    if (twin) return json({ok: true, stored: true, ref: twin.ref});

    /* Two people can reach the last one in the same moment. The shop greys out
       what it knew about; this is the check that actually decides. */
    const gone = await soldOut(env, o.items);
    if (gone.length)
      return json({ok: false, stored: false, why: "sold out", gone}, 409);

    /* The number is the shop's to give, not the browser's — whatever code the
       page guessed while she was filling the form is ignored. OR IGNORE means
       a number taken in the meantime writes nothing, and we go round again. */
    let ref = "";
    for (let i = 0; i < 6 && !ref; i++) {
      const t = await nextRef(env);
      const res = await env.DB.prepare(
        `INSERT OR IGNORE INTO orders
         (ref, placed_at, name, phone, pincode, address, pay, poth, items,
          goods, shipping, cod_fee, total, status, note, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'new','',?)`
      ).bind(
        t, o.placed_at, o.name, o.phone, o.pincode, o.address, o.pay, o.poth,
        items, o.goods, o.shipping, o.cod_fee, o.total, o.placed_at
      ).run();
      if (didWrite(res)) ref = t;
    }
    if (!ref) return json({ok: false, stored: false, why: "write failed"}, 200);

    return json({ok: true, stored: true, ref});
  } catch (err) {
    /* Database trouble is our problem, not the customer's. */
    return json({ok: false, stored: false, why: "write failed"}, 200);
  }
}

/* Everything the form can send, checked and rebuilt from scratch. */
function clean(b) {
  const s = (v, max) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);

  /* The page still sends the code it guessed, so that an older cached copy of
     the shop keeps working, but nothing is done with it: the number an order
     ends up with is the one the book hands out. */

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
    placed_at: new Date().toISOString(), name, phone, pincode, address,
    pay, poth, items, goods, shipping, cod_fee, total: goods + shipping + cod_fee
  };
}

/* ===========================================================================
   How many are left
   ===========================================================================
   There is no second set of books. How many of a piece are spoken for is
   worked out from the orders themselves, every time, so it can never drift
   away from what the order book shows.
*/
async function takenNow(env) {
  const taken = {};                                   // {"NECKLACE-01": 2}
  if (!env.DB) return taken;

  const cutoff = new Date(Date.now() - HOLD_HOURS * 3600e3).toISOString();
  const marks = HOLDS_FOREVER.map(() => "?").join(",");
  const held = `(status IN (${marks}) OR (status = 'new' AND placed_at > ?))`;

  /* Only the website's own orders. An order taken on WhatsApp was agreed with
     a piece already in somebody's hand, so counting it here would take the
     same piece off the shop twice. */
  let results;
  try {
    ({results} = await env.DB.prepare(
      `SELECT items FROM orders WHERE source = 'site' AND ${held}`
    ).bind(...HOLDS_FOREVER, cutoff).all());
  } catch {
    /* An order book from before the source column. Everything in it is a
       website order, so there is nothing to leave out. */
    ({results} = await env.DB.prepare(
      `SELECT items FROM orders WHERE ${held}`
    ).bind(...HOLDS_FOREVER, cutoff).all());
  }

  for (const row of results || []) {
    let items;
    try { items = JSON.parse(row.items) || []; } catch { continue; }
    for (const it of items) {
      if (!it || !it.code) continue;
      taken[it.code] = (taken[it.code] || 0) + (Number(it.qty) || 1);
    }
  }
  return taken;
}

/* How many the shop has of each piece. That lives with the piece, in the
   catalogue the site already publishes, so there is nothing extra to keep in
   step. Held briefly in memory because it only changes on a deploy. */
let MADE = null, MADE_AT = 0;

async function howManyMade(env) {
  if (MADE && Date.now() - MADE_AT < 300e3) return MADE;
  const out = {};
  try {
    const res = await env.ASSETS.fetch(new Request("https://qala.local/photos/catalogue.json"));
    if (res.ok) {
      const cat = await res.json();
      for (const c of cat.categories || [])
        for (const p of c.products || []) {
          const n = p.sizes && p.sizes.qty;
          out[p.code] = Number.isFinite(n) ? n : 1;      // nothing said means one
        }
    }
  } catch { /* no catalogue is the same as knowing nothing */ }
  MADE = out; MADE_AT = Date.now();
  return out;
}

/* What the next order code will most likely be. The checkout page asks for
   this while she is still filling the form, so the code is already in hand
   when she taps — the WhatsApp message has to be written there and then.
   It is a look, not a claim: the number an order really gets is settled when
   it is written down. */
async function peekRef(env) {
  try {
    return json({ok: true, ref: await nextRef(env)}, 200, {"cache-control": "no-store"});
  } catch {
    return json({ok: false}, 200, {"cache-control": "no-store"});
  }
}

async function stockNow(request, env) {
  const [made, taken] = await Promise.all([howManyMade(env), takenNow(env)]);
  const left = {};
  for (const code of Object.keys(made)) left[code] = Math.max(0, made[code] - (taken[code] || 0));
  return json({ok: true, left, holdHours: HOLD_HOURS}, 200,
    /* Half a minute: quick enough that a sold-out piece greys out promptly,
       long enough that a busy evening does not hammer the database. */
    {"cache-control": "public, max-age=30"});
}

/* ===========================================================================
   How many people are on the shop right now
   ===========================================================================
   Each open tab makes up a random id for itself and says hello every so often.
   We keep the id and the time, count how many said hello recently, and give
   that number back. That is the whole thing.

   What is deliberately NOT here: no address, no name, no cookie, nothing that
   identifies anybody and nothing that outlives the visit. The id is made by
   the browser, thrown away when the tab closes, and the row is swept up ten
   minutes later. It cannot be joined to an order or to anything else.

   The number is the real one. If two people are on the shop it says two.
*/
async function whoIsHere(request, env) {
  if (!env.DB) return json({ok: true, here: 0}, 200, {"cache-control": "no-store"});

  let id = "";
  try { id = String((await request.json()).id || ""); } catch (e) { /* no id, no count */ }
  if (!/^[a-z0-9]{8,40}$/i.test(id)) return json({ok: false, here: 0}, 400);

  const now = new Date();
  const since = new Date(now.getTime() - HERE_MINUTES * 60e3).toISOString();

  try {
    await env.DB.prepare("INSERT OR REPLACE INTO here (id, at) VALUES (?, ?)")
      .bind(id, now.toISOString()).run();

    /* Sweeping on every hello would double the writes for nothing, so it
       happens now and then instead. Nobody is waiting on it. */
    if (Math.random() < 0.05) {
      const old = new Date(now.getTime() - HERE_SWEEP_AFTER * 60e3).toISOString();
      await env.DB.prepare("DELETE FROM here WHERE at < ?").bind(old).run();
    }

    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM here WHERE at > ?")
      .bind(since).first();
    return json({ok: true, here: (row && row.n) || 1}, 200, {"cache-control": "no-store"});
  } catch (err) {
    /* No table yet, or the database is having a moment. The shop simply does
       not show the badge, and nothing else notices. */
    return json({ok: false, here: 0}, 200, {"cache-control": "no-store"});
  }
}

/* Anything on this order that somebody else has already taken. */
async function soldOut(env, items) {
  const [made, taken] = await Promise.all([howManyMade(env), takenNow(env)]);
  const gone = [], mine = {};
  for (const it of items) {
    if (!(it.code in made)) continue;             // a piece we know nothing about
    mine[it.code] = (mine[it.code] || 0) + it.qty;
    if ((taken[it.code] || 0) + mine[it.code] > made[it.code])
      gone.push({code: it.code, title: it.title, left: Math.max(0, made[it.code] - (taken[it.code] || 0))});
  }
  return gone;
}

/* ===========================================================================
   The studio's way to GitHub
   ===========================================================================
   The studio used to hold a GitHub token in the browser, which meant the token
   travelled to every phone anybody signed in on. It does not any more. The
   token lives here as a secret, and the studio asks this to pass its requests
   along.

   Three things make that safe to do:

     1. Only a signed-in person gets through at all.
     2. The repository is fixed here, from GITHUB_REPO. Nothing the browser
        sends can change which repository is written to.
     3. Only the handful of GitHub paths the studio actually uses are allowed,
        and only for reading, adding and moving a branch — never deleting.

   Needs two variables on the project:
     GITHUB_REPO    owner/repository, e.g. swolfyguy/the-qala-site
     GITHUB_TOKEN   a fine-grained token with Contents: Read and write
                    on that one repository. Set it as a SECRET.
*/

/* Exactly what the studio does, and nothing else. */
const GH_ALLOWED = [
  ["GET",   /^git\/ref\/heads\/[^?]+$/],       // where the branch points
  ["GET",   /^git\/commits\/[0-9a-f]{40}$/],    // that commit
  ["GET",   /^git\/trees\/[0-9a-f]{40}/],       // and its tree
  ["GET",   /^contents\//],                     // a file, for thumbnails
  ["POST",  /^git\/blobs$/],                    // add a file
  ["POST",  /^git\/trees$/],                    // build the new tree
  ["POST",  /^git\/commits$/],                  // make the commit
  ["PATCH", /^git\/refs\/heads\/[^?]+$/]       // and move the branch to it
];

async function toGitHub(request, env, path) {
  const who = await whoGoes(request, env);
  if (!who.ok) return json({ok: false, login: true, why: who.why}, 401);

  const rest = path.slice("/office/gh/".length);

  /* The studio asks what it is allowed to see before it does anything. */
  if (rest === "config") {
    const set = !!(env.GITHUB_TOKEN && env.GITHUB_REPO);
    return json({ok: set, hosted: true, repo: env.GITHUB_REPO || "",
                 branch: env.GITHUB_BRANCH || "main", you: who.who,
                 why: set ? "" :
                   "This site has no GitHub token yet. Add GITHUB_REPO and GITHUB_TOKEN " +
                   "to the project, then deploy again."});
  }

  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO)
    return json({ok: false, why: "No GitHub token is set on this project."}, 503);
  if (!/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPO))
    return json({ok: false, why: "GITHUB_REPO should look like owner/repository."}, 503);

  const url = new URL(request.url);
  const asked = rest + (url.search || "");

  /* Both the runtime and the browser flatten "..", so this should never fire.
     It is here so that the guarantee is this file's, not the runtime's:
     checked decoded too, since %2e%2e is the same thing wearing a hat. */
  let plain = rest;
  try { plain = decodeURIComponent(rest); } catch (e) { /* leave it as it came */ }
  if (rest.startsWith("/") || /(^|[\\/])\.\.([\\/]|$)/.test(plain) || plain.includes("\\"))
    return json({ok: false, why: "not a path this can reach"}, 400);

  const allowed = GH_ALLOWED.some(([m, re]) => m === request.method && re.test(rest));
  if (!allowed) return json({ok: false, why: `${request.method} ${rest} is not something the studio does`}, 403);

  /* Built here, from the repository this project is fixed to. Nothing the
     browser sent takes part in choosing it. */
  const target = `https://api.github.com/repos/${env.GITHUB_REPO}/${asked}`;

  const headers = new Headers({
    "Authorization": "Bearer " + env.GITHUB_TOKEN,
    "Accept": request.headers.get("Accept") || "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "the-qala-studio"
  });
  const ct = request.headers.get("Content-Type");
  if (ct) headers.set("Content-Type", ct);

  let res;
  try {
    res = await fetch(target, {
      method: request.method,
      headers,
      /* Passed straight through, so a batch of photographs costs almost no
         processing here — which matters on the free plan. */
      body: (request.method === "GET" || request.method === "HEAD") ? undefined : request.body
    });
  } catch (err) {
    return json({ok: false, why: "Could not reach GitHub just now."}, 502);
  }

  const out = new Headers();
  const keep = ["content-type", "etag", "link", "x-ratelimit-remaining"];
  for (const k of keep) { const v = res.headers.get(k); if (v) out.set(k, v); }
  out.set("cache-control", "no-store");
  return new Response(res.body, {status: res.status, headers: out});
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

/* A day picked in the order book means that whole day in the shop, not in
   UTC — otherwise a day would start at half past five in the morning.
   "2026-09-12" becomes the moment that day began in Indian time. */
const IST = 5.5 * 3600e3;

/* ---------------------------------------------------------------------------
   The order code
   ---------------------------------------------------------------------------
   Q-2609-01 — Q, the year and the month, then this order's place in that
   month, counted from one and starting again each month. Short enough to read
   down a telephone.

   Codes made before this change, QALA-2609-4471 and the like, are still real
   orders sitting in the book, so everything that takes a code accepts both. */
const REF_NEW = /^Q-\d{4}-\d{2,4}$/;
const REF_OLD = /^QALA-\d{4}-\d{4}$/;
const isRef = r => REF_NEW.test(r) || REF_OLD.test(r);

/* Dated by the shop's day, so an order taken at half past midnight belongs to
   the month the shop thinks it does. */
const monthStamp = () => {
  const d = new Date(Date.now() + IST);
  return String(d.getUTCFullYear()).slice(2) + String(d.getUTCMonth() + 1).padStart(2, "0");
};

/* The next number for this month. Read, not held: two orders arriving in the
   same moment are both told the same number, and the insert settles which one
   actually gets it — the caller tries again with what is free by then.
   Ordered by length first so that Q-2609-100 comes after Q-2609-99. */
async function nextRef(env) {
  const stamp = monthStamp();
  const row = await env.DB.prepare(
    "SELECT ref FROM orders WHERE ref LIKE ? ORDER BY LENGTH(ref) DESC, ref DESC LIMIT 1"
  ).bind(`Q-${stamp}-%`).first();
  const last = row ? parseInt(String(row.ref).split("-")[2], 10) : 0;
  return `Q-${stamp}-${String((Number.isFinite(last) ? last : 0) + 1).padStart(2, "0")}`;
}

/* Did that write actually put a row in? INSERT OR IGNORE says nothing out
   loud when the code was taken, so the count of changed rows is the answer. */
const didWrite = res => !(res && res.meta && typeof res.meta.changes === "number")
                        || res.meta.changes > 0;
function dayStart(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(text || ""))) return null;
  const t = Date.parse(text + "T00:00:00Z");
  return Number.isFinite(t) ? new Date(t - IST).toISOString() : null;
}
function dayEnd(text) {
  const start = dayStart(text);
  return start ? new Date(Date.parse(start) + 24 * 3600e3 - 1).toISOString() : null;
}

/* Midnight in Indian time, this many days back — because a day in the book is
   the shop's day, not a UTC one, and "yesterday" has to mean what she means. */
function istMidnight(daysBack) {
  const ist = new Date(Date.now() + 5.5 * 3600e3);
  ist.setUTCHours(0, 0, 0, 0);
  return new Date(ist.getTime() - daysBack * 24 * 3600e3 - 5.5 * 3600e3).toISOString();
}
const justBefore = iso => new Date(Date.parse(iso) - 1).toISOString();

/* The stretches of time the book offers, counted in whole days: "last 3 days"
   is today and the two before it, not seventy-two hours. Worked out here so
   the list, the counts and the CSV all agree with what is on screen. */
function span(range) {
  switch (range) {
    case "today":     return {from: istMidnight(0),  upto: null};
    case "yesterday": return {from: istMidnight(1),  upto: justBefore(istMidnight(0))};
    case "3d":        return {from: istMidnight(2),  upto: null};
    case "7d":        return {from: istMidnight(6),  upto: null};
    case "30d":       return {from: istMidnight(29), upto: null};
    default:          return {from: null, upto: null};   /* everything */
  }
}

async function listOrders(env, url, who) {
  const status = url.searchParams.get("status") || "";
  const q      = (url.searchParams.get("q") || "").trim();
  const range  = url.searchParams.get("range") || "all";

  /* Two picked days win over the presets, and either one alone is fine —
     "from the 12th" and "up to the 18th" are both reasonable things to ask. */
  const pickedFrom = dayStart(url.searchParams.get("from"));
  const pickedTo   = dayEnd(url.searchParams.get("to"));
  const picked     = !!(pickedFrom || pickedTo);
  const preset = span(range);
  const from = picked ? pickedFrom : preset.from;
  const upto = picked ? pickedTo   : preset.upto;
  const limit  = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "200", 10) || 200, 1), 1000);

  let sql = "SELECT * FROM orders", where = [], bind = [];
  /* "deleted" is a bin, not a state an order passes through. Everything means
     everything still in the book, so the bin is left out of it — you only see
     those by asking for them. */
  if (status && status !== "all") { where.push("status = ?"); bind.push(status); }
  else where.push("status != 'deleted'");
  if (from) { where.push("placed_at >= ?"); bind.push(from); }
  if (upto) { where.push("placed_at <= ?"); bind.push(upto); }
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

  /* Counted over the same stretch of time, so the tabs match the list. */
  const cWhere = [], cBind = [];
  if (from) { cWhere.push("placed_at >= ?"); cBind.push(from); }
  if (upto) { cWhere.push("placed_at <= ?"); cBind.push(upto); }
  const counts = await env.DB.prepare(
    "SELECT status, COUNT(*) AS n FROM orders"
    + (cWhere.length ? " WHERE " + cWhere.join(" AND ") : "")
    + " GROUP BY status"
  ).bind(...cBind).all();

  /* The Everything tab counts what Everything shows, so the bin is not in it.
     The bin's own tab counts itself, from the same rows. */
  const rows2 = counts.results || [];
  const binned = (rows2.find(r => r.status === "deleted") || {}).n || 0;

  return json({ok: true, you: who, orders: rows, counts: rows2, binned,
                range: picked ? "picked" : range});
}

async function updateOrder(request, env) {
  let b;
  try { b = await request.json(); } catch { return json({ok: false, why: "bad body"}, 400); }

  const ref = String(b.ref || "");
  if (!isRef(ref)) return json({ok: false, why: "ref"}, 400);

  const was = await env.DB.prepare("SELECT * FROM orders WHERE ref = ?").bind(ref).first();
  if (!was) return json({ok: false, why: "not found"}, 404);

  /* Gone for good. Deliberately only possible on an order already sitting in
     the bin: one tap can never take a live order off the books, and the row
     you are about to lose has been out of your way for a while first. */
  if (b.purge === true) {
    if (was.status !== "deleted")
      return json({ok: false, why: "Move it to Deleted first, then it can be removed for good."}, 400);
    try { await env.DB.prepare("DELETE FROM order_photos WHERE ref = ?").bind(ref).run(); }
    catch (e) { /* no photographs table on an older book, which is fine */ }
    await env.DB.prepare("DELETE FROM orders WHERE ref = ?").bind(ref).run();
    return json({ok: true, purged: ref});
  }

  const allowed = ["new", "confirmed", "sent", "done", "cancelled", "deleted"];
  const sets = [], bind = [];
  if (b.status != null) {
    if (!allowed.includes(b.status)) return json({ok: false, why: "status"}, 400);
    sets.push("status = ?"); bind.push(b.status);
  }
  if (b.note != null) { sets.push("note = ?"); bind.push(String(b.note).slice(0, 500)); }

  /* How she is paying, put right afterwards: she rang and said she would
     rather come and collect it, or pay online instead of cash at the door.
     Money already taken online cannot be talked out of — that one is settled. */
  let newPay = null;
  if (b.pay != null) {
    const pay = String(b.pay);
    if (!["online", "shop", "cod"].includes(pay))
      return json({ok: false, why: "That is not a way of paying."}, 400);
    if (was.pay_state === "paid" && pay !== "online")
      return json({ok: false, why: "This one is already paid online."}, 400);
    newPay = pay;
    sets.push("pay = ?"); bind.push(pay);
  }
  if (b.poth != null) {
    const p = String(b.poth).trim();
    if (p && !POTH.includes(p)) return json({ok: false, why: "poth"}, 400);
    sets.push("poth = ?"); bind.push(p);
  }

  /* Filling in the price the shop agreed in the chat.
     Only ever on an order that did not come through the website — a customer
     who saw a price on the shop must not have it changed underneath her. */
  if (b.price != null) {
    if ((was.source || "site") === "site")
      return json({ok: false, why: "A website order keeps the price the customer saw."}, 400);
    const price = Math.floor(Number(b.price));
    if (!Number.isFinite(price) || price < 0 || price > 5000000)
      return json({ok: false, why: "That is not a price."}, 400);
    sets.push("goods = ?", "total = ?"); bind.push(price, price);
    /* Carry it onto the piece as well, so the card does not contradict itself. */
    const items = safeItems(was.items);
    if (items.length === 1) {
      items[0].price = price;
      sets.push("items = ?"); bind.push(JSON.stringify(items));
    }
  }

  /* On a website order the money follows the way of paying: collecting at the
     shop pays no shipping, cash on delivery costs extra. It is worked out here
     from the goods already on the row, never from anything the browser sent.
     An order taken on WhatsApp has one agreed price with nothing added to it,
     so there changing how she pays changes only the word. */
  if (newPay && (was.source || "site") === "site") {
    const goods    = Number(was.goods) || 0;
    const shipping = newPay === "shop" ? 0 : (goods >= SHIP_FREE_OVER ? 0 : SHIP_FLAT);
    const cod_fee  = newPay === "cod" ? COD_EXTRA : 0;
    sets.push("shipping = ?", "cod_fee = ?", "total = ?");
    bind.push(shipping, cod_fee, goods + shipping + cod_fee);
  }

  /* The photograph, added or replaced or taken away afterwards. An empty
     string means remove it. */
  let shot = null;
  if (b.photo != null) {
    const raw = String(b.photo).trim();
    if (!raw) shot = {mime: "", data: ""};
    else {
      const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(raw);
      if (!m) return json({ok: false, why: "That picture is not a kind we can keep."}, 400);
      if (m[2].length > MAX_PHOTO_CHARS) return json({ok: false, why: "That picture is too big."}, 400);
      shot = {mime: m[1], data: m[2]};
    }
  }

  if (!sets.length && !shot) return json({ok: false, why: "nothing to change"}, 400);

  if (shot) {
    try {
      if (shot.mime) await env.DB.prepare(
        "INSERT OR REPLACE INTO order_photos (ref, mime, data) VALUES (?,?,?)"
      ).bind(ref, shot.mime, shot.data).run();
      else await env.DB.prepare("DELETE FROM order_photos WHERE ref = ?").bind(ref).run();
    } catch {
      return json({ok: false, why: "The order book has no order_photos table yet. "
        + "Paste schema.sql into the D1 console again."}, 500);
    }
    sets.push("photo = ?"); bind.push(shot.mime);
  }

  sets.push("updated_at = ?"); bind.push(new Date().toISOString());
  bind.push(ref);

  await env.DB.prepare(`UPDATE orders SET ${sets.join(", ")} WHERE ref = ?`).bind(...bind).run();
  const row = await env.DB.prepare("SELECT * FROM orders WHERE ref = ?").bind(ref).first();
  if (!row) return json({ok: false, why: "not found"}, 404);
  return json({ok: true, order: {...row, items: safeItems(row.items)}});
}

const safeItems = s => { try { return JSON.parse(s) || []; } catch { return []; } };

function toCsv(rows) {
  const head = ["ref", "placed_at", "status", "came_from", "name", "phone", "pincode", "address",
                "pay", "poth", "pieces", "goods", "shipping", "cod_fee", "total", "note"];
  const cell = v => {
    const s = v == null ? "" : String(v);
    /* A leading =, +, - or @ is how a spreadsheet gets tricked into running
       something. Prefix it so Excel treats the cell as plain text. */
    const safe = /^[=+\-@]/.test(s) ? "'" + s : s;
    return /[",\n]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
  };
  const line = r => [
    r.ref, r.placed_at, r.status, SOURCENAME[r.source] || r.source || "the website",
    r.name, "'" + r.phone, r.pincode, r.address, r.pay,
    r.poth ? r.poth + " in" : "",
    r.items.map(i => `${i.code} x${i.qty}`).join(" | "),
    r.goods, r.shipping, r.cod_fee, r.total, r.note
  ].map(cell).join(",");
  return "﻿" + [head.join(","), ...rows.map(line)].join("\r\n");
}

/* ===========================================================================
   An order that did not come through the website
   ===========================================================================
   Most of the shop's orders are agreed in a chat. A photograph arrives on
   WhatsApp or Instagram, a length is settled, a price is agreed, and that is
   the whole order — living in the chat and nowhere else, until it is time to
   pack and somebody has to scroll back through a month of messages.

   This puts those in the same book as the website's, marked with where they
   came from, so one list is the whole day's work. Two things make an office
   order different:

     1. Nobody outside can make one. It is behind the same sign-in as the
        order book, and the price is whatever the shop types.
     2. It does not touch how many are left on the website, because the piece
        was already set aside by hand when the chat was answered.
*/
async function newOrder(request, env) {
  const who = await whoGoes(request, env);
  if (!who.ok) return json({ok: false, login: true, why: who.why}, 401);
  if (!env.DB)  return json({ok: false, why: "The DB binding is not attached to this project yet."}, 503);

  let body;
  try { body = await request.json(); }
  catch { return json({ok: false, why: "bad body"}, 400); }

  const o = cleanOffline(body);
  if (o.error) return json({ok: false, why: o.error}, 400);

  /* A code nobody else has, in the website's own shape, so that everything
     which reads the book afterwards — the status buttons, the CSV — treats
     an office order exactly like any other. */
  let ref = "", failed = null;
  for (let i = 0; i < 6 && !ref; i++) {
    const t = await nextRef(env);
    try {
      const res = await env.DB.prepare(
        `INSERT OR IGNORE INTO orders
         (ref, placed_at, name, phone, pincode, address, pay, poth, items,
          goods, shipping, cod_fee, total, status, note, source, photo, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,0,0,?,'new',?,?,?,?)`
      ).bind(t, o.placed_at, o.name, o.phone, o.pincode, o.address, o.pay, o.poth,
             JSON.stringify(o.items), o.goods, o.total, o.note, o.source, o.mime, o.placed_at).run();
      if (didWrite(res)) ref = t;
    } catch (err) { failed = err; break; }
  }
  if (failed) return json({ok: false, why: "The order book has not been given its newer columns yet. "
    + "Run the three ALTER TABLE lines at the bottom of schema.sql, then try again."}, 500);
  if (!ref) return json({ok: false, why: "Could not make an order code. Try once more."}, 503);

  /* The picture is kept in a table of its own, so listing the book never drags
     photographs along, and a picture that will not save never costs the order. */
  let kept = false;
  if (o.mime) {
    try {
      await env.DB.prepare(
        "INSERT OR REPLACE INTO order_photos (ref, mime, data) VALUES (?,?,?)"
      ).bind(ref, o.mime, o.data).run();
      kept = true;
    } catch { kept = false; }
    if (!kept) {
      try { await env.DB.prepare("UPDATE orders SET photo = '' WHERE ref = ?").bind(ref).run(); }
      catch { /* the order is saved either way, which is the part that matters */ }
    }
  }

  return json({ok: true, ref, photo: kept,
    warn: o.mime && !kept ? "The order is saved, but the picture would not go in." : ""});
}

/* ===========================================================================
   The details she fills in herself
   ===========================================================================
   The other half of the same idea. Instead of the shop typing her address out
   of a chat, the shop sends her a link — theqalashree.com/order/ — and she
   fills in her own name, number, address and length. The photograph and the
   price stay with the shop, because those are the shop's to decide.

   This one IS open to the whole internet, so it is treated exactly like the
   website's own order form: everything rebuilt from scratch, the same flood
   guards, and no price of any kind accepted from the browser.
*/
async function chatOrder(request, env) {
  if (!env.DB) return json({ok: false, stored: false, why: "no database"}, 200);

  let body;
  try { body = await request.json(); }
  catch { return json({ok: false, why: "bad body"}, 400); }

  const o = cleanChat(body);
  if (o.error) return json({ok: false, why: o.error}, 400);

  /* The same two counts the website's form does. */
  const dayAgo    = new Date(Date.now() - 24 * 3600e3).toISOString();
  const minuteAgo = new Date(Date.now() - 60e3).toISOString();
  try {
    const mine = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM orders WHERE phone = ? AND placed_at > ?"
    ).bind(o.phone, dayAgo).first();
    if (mine && mine.n >= MAX_PER_PHONE_PER_DAY)
      return json({ok: false, why: "You have sent this a few times today already. "
        + "Message us on WhatsApp and we will sort it out there."}, 429);

    const all = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM orders WHERE placed_at > ?"
    ).bind(minuteAgo).first();
    if (all && all.n >= MAX_PER_MINUTE)
      return json({ok: false, why: "We are a little busy. Try again in a minute."}, 429);
  } catch { /* a count that will not run is no reason to lose her address */ }

  let ref = "", failed = null;
  for (let i = 0; i < 6 && !ref; i++) {
    const t = await nextRef(env);
    try {
      const res = await env.DB.prepare(
        `INSERT OR IGNORE INTO orders
         (ref, placed_at, name, phone, pincode, address, pay, poth, items,
          goods, shipping, cod_fee, total, status, note, source, photo, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,0,0,0,0,'new',?,?,'',?)`
      ).bind(t, o.placed_at, o.name, o.phone, o.pincode, o.address, o.pay, o.poth,
             JSON.stringify(o.items), o.note, o.source, o.placed_at).run();
      if (didWrite(res)) ref = t;
    } catch (err) { failed = err; break; }
  }
  if (failed) return json({ok: false, why: "We could not save that just now. "
    + "Please send us your address on WhatsApp instead."}, 500);
  if (!ref) return json({ok: false, why: "Something went wrong here. Please message us."}, 503);

  return json({ok: true, ref});
}

/* What she is allowed to tell us, and nothing else. There is no price here on
   purpose — not an ignored one, not a hidden one. The book gets a zero until
   the shop types the figure it agreed with her. */
function cleanChat(b) {
  const s = (v, max) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);

  const name = s(b.name, 80);
  if (name.length < 2) return {error: "Please put in your name."};

  const phone = String(b.phone || "").replace(/\D/g, "").slice(-10);
  if (!/^[6-9]\d{9}$/.test(phone)) return {error: "That phone number does not look right."};

  const pincode = String(b.pin || "").replace(/\D/g, "").slice(0, 6);
  if (!/^\d{6}$/.test(pincode)) return {error: "A pincode is six digits."};

  const address = s(b.addr, 400);
  if (address.length < 12) return {error: "Please put in the whole address, so the parcel arrives."};

  const poth = s(b.poth, 4);
  if (poth && !POTH.includes(poth)) return {error: "That is not a length we make."};

  const pay = ["online", "shop", "cod"].includes(b.pay) ? b.pay : "online";

  /* Which chat she came from, carried in the link the shop sent her. Anything
     else, and we simply do not know. */
  const source = SOURCES.includes(b.source) ? b.source : "whatsapp";

  const want = s(b.want, 120);
  const note = s(b.note, 500);

  return {placed_at: new Date().toISOString(), name, phone, pincode, address, pay, poth,
          items: [Object.assign({code: "OFFLINE", title: want || "To be filled in by the shop",
                                 qty: 1, price: 0}, poth ? {size: poth} : {})],
          note, source};
}

/* Everything the office form can send, checked and rebuilt from scratch —
   the same treatment the public form gets. Signed in is not the same as
   careful, and a mistyped pincode is a parcel that goes nowhere. */
function cleanOffline(b) {
  const s = (v, max) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);

  const name = s(b.name, 80);
  if (name.length < 2) return {error: "Put in a name."};

  const phone = String(b.phone || "").replace(/\D/g, "").slice(-10);
  if (!/^[6-9]\d{9}$/.test(phone)) return {error: "That phone number does not look right."};

  const source = SOURCES.includes(b.source) ? b.source : "";
  if (!source) return {error: "Say where the order came from."};

  const pay = ["online", "shop", "cod"].includes(b.pay) ? b.pay : "online";

  const poth = s(b.poth, 4);
  if (poth && !POTH.includes(poth)) return {error: "That is not a length the shop offers."};

  const pickup  = pay === "shop";
  const pincode = pickup ? "" : String(b.pin || "").replace(/\D/g, "").slice(0, 6);
  const address = pickup ? "" : s(b.addr, 400);
  /* An address often arrives later in the same chat, so it is not demanded
     here — but half a pincode is worse than none. */
  if (pincode && !/^\d{6}$/.test(pincode)) return {error: "A pincode is six digits."};

  /* The price can wait. If it is not settled yet, the order goes in at nothing
     and the book shows it as "not set yet" until somebody types the figure. */
  const asked = String(b.price == null ? "" : b.price).trim();
  const price = asked === "" ? 0 : Math.floor(Number(b.price));
  if (!Number.isFinite(price) || price < 0 || price > 5000000)
    return {error: "That is not a price."};

  /* Optional: the code of a piece that is already on the website. When it is
     given, the order book shows that piece's photograph and links to it. */
  const code  = s(b.code, 24).toUpperCase().replace(/[^A-Z0-9_-]/g, "");
  const title = s(b.title, 120) || ("Piece from " + (SOURCENAME[source] || source));
  const note  = s(b.note, 500);

  const item = {code: code || "OFFLINE", title, qty: 1, price};
  if (poth) item.size = poth;

  /* The photograph, already shrunk in the browser to something a chat-sized
     picture becomes anyway. Only the three kinds a phone camera produces. */
  let mime = "", data = "";
  const shot = typeof b.photo === "string" ? b.photo.trim() : "";
  if (shot) {
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(shot);
    if (!m) return {error: "That picture is not a kind we can keep. Use a photo from the chat."};
    if (m[2].length > MAX_PHOTO_CHARS) return {error: "That picture is too big, even shrunk."};
    mime = m[1]; data = m[2];
  }

  return {placed_at: new Date().toISOString(), name, phone, pincode, address, pay, poth,
          items: [item], goods: price, total: price, note, source, mime, data};
}

/* Handing a picture back. Never straight from the database to the internet —
   these are customers' own photographs, so the sign-in is checked first, and
   the browser is told plainly what the file is and not to guess. */
const EXT = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"};

async function photoOut(request, env, path) {
  const who = await whoGoes(request, env);
  if (!who.ok) return new Response("Sign in first.", {status: 401});
  if (!env.DB)  return new Response("No database.", {status: 503});

  const ref = decodeURIComponent(path.slice("/office/img/".length));
  if (!isRef(ref)) return new Response("Not found", {status: 404});

  let row;
  try {
    row = await env.DB.prepare("SELECT mime, data FROM order_photos WHERE ref = ?").bind(ref).first();
  } catch { return new Response("Not found", {status: 404}); }
  if (!row || !EXT[row.mime]) return new Response("Not found", {status: 404});

  const bin = atob(row.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  return new Response(bytes, {headers: {
    "content-type": row.mime,
    /* Signed in only, and a picture never changes once it is in. */
    "cache-control": "private, max-age=86400",
    "content-disposition": `inline; filename="${ref}.${EXT[row.mime]}"`,
    "x-content-type-options": "nosniff"
  }});
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
