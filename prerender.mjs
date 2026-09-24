/* ---------------------------------------------------------------------------
   The Qala — real, crawlable pages for the pieces, the categories, and the
   five policy pages.

   WHY THIS EXISTS

   The shop is a single-page app addressed by hash: #/piece/CODE, #/shop?c=...
   and so on. Everything after the # is invisible to the server — the browser
   never sends it — so every one of those addresses returns the exact same
   HTML from Cloudflare: the one <title>, the one <meta description>, the one
   pair of JSON-LD blocks, on every single page. A search engine or an AI
   crawler reading theqalashree.com/#/piece/RANI-HAAR-01 sees nothing that
   says "Rani Haar" anywhere in the response. It cannot be found by name and
   it cannot be cited by name.

   This script closes that gap by writing a REAL file for each one:

       piece/<code>/index.html      one per product
       shop/<slug>/index.html       one per category
       terms/index.html  privacy/index.html  shipping/index.html
       returns/index.html  refunds/index.html

   Each file is the exact same page the app already builds — same header,
   same footer, same CSS, same <script> tags — so a person who lands on it
   gets the full, ordinary, interactive site. Two things differ:

     1. The <head> — title, description, canonical, Open Graph, Twitter card,
        and a JSON-LD block written for THAT piece or THAT category, instead
        of the one block that describes the shop as a whole.

     2. The empty <main id="view"></main> the app starts with is filled in
        ahead of time, with exactly what the app itself would put there. A
        crawler that does not run JavaScript — several of the AI ones do
        not — still reads the real content: the price, the sizes, the
        description, the photos.

   HOW THE CONTENT IS GOT

   Not retyped, and not re-implemented in Python next to the real thing where
   it would drift the first time somebody changes a price. This script starts
   the shop exactly as `node dev.mjs` does, opens each address in a headless
   browser, lets the app's own code render it, and lifts the result out. The
   HTML in these files is never anything other than what the app produced.

   WHY THE APP ITSELF STILL RUNS ON TOP

   A person who opens one of these pages is not meant to see a static
   photograph of the shop — she should be able to add it to her bag, see the
   size selector, follow another link, all of it. So every file keeps every
   <script> tag from the original, unchanged. A one-line addition near the
   top sets location.hash to the right address before those scripts run, so
   when the app boots it renders the very page already on the screen —
   invisibly, with nothing to redraw. Nothing about the app's own router
   changes; it is not even aware this file exists.

   NEEDS PLAYWRIGHT, ONCE:

       npm install playwright
       npx playwright install chromium

   That writes a node_modules folder here — .gitignore and .assetsignore
   already keep it out of git and out of the deploy, same as everything
   else in this list that only runs on your own computer.

   RUN THIS AFTER build_catalogue.py, WITH THE SHOP RUNNING:

       python3 build_catalogue.py
       node dev.mjs &
       node prerender.mjs
--------------------------------------------------------------------------- */

import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {chromium} from "playwright";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.PRERENDER_BASE || "http://localhost:8788";
const SITE = "https://theqalashree.com";

const read  = p => fs.readFileSync(path.join(ROOT, p), "utf8");
const write = (p, s) => {
  fs.mkdirSync(path.dirname(path.join(ROOT, p)), {recursive: true});
  fs.writeFileSync(path.join(ROOT, p), s, "utf8");
};

const esc = s => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const CATALOGUE = JSON.parse(read("photos/catalogue.json"));

/* The shop's own names for each shelf — copied by hand from index.html's
   CAT_NAMES, because that is the one place they are written down. A blurb
   left blank there (single-wati-rajwadi, hand-made-rajwadi,
   double-wati-rajwadi-handmade) is left blank here too, exactly like the
   live page: nothing invented in either place. */
const CAT_NAMES = {
  "rajwadi": {en: "Rajwadi",
    blurb: "The Peshwa-court jewellery of Maharashtra. Hollow gold beads strung so tightly the necklace holds its own curve, jav leaves laid in a row, struck Lakshmi coins, and a single red kundan at the heart of it. Thushi, saaj, mohanmal, nath and bugadi — the pieces a bride is dressed in — finished in a soft antique gold rather than a hard polish, the way they were made before machines."},
  "hand-made-rajwadi": {en: "Hand Made Rajwadi", blurb: ""},
  "single-wati-rajwadi": {en: "Single Wati Rajwadi", blurb: ""},
  "double-wati-rajwadi-handmade": {en: "Double Wati Rajwadi", blurb: ""},
  "rani-haar": {en: "Rani Haar", blurb: ""},
  "necklace": {en: "Necklace", blurb: ""},
  "victorian": {en: "Victorian", blurb: ""},
};
const titleish = s => s.split(/[-_]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
const catName = slug => CAT_NAMES[slug] || {en: titleish(slug), blurb: ""};

/* ---- what each policy page's <meta description> should say -------------
   Kept short and factual, one sentence, pulled from what that page actually
   says — never a friendlier rewrite of it. */
const POLICY_META = {
  terms:    "Terms and conditions for ordering from The Qala, Dighi, Pune.",
  privacy:  "How The Qala collects and uses your information when you order.",
  shipping: "Shipping costs, dispatch times and how to pay — online, cash at the shop, or cash on delivery — at The Qala.",
  returns:  "The Qala's policy on damaged, wrong or unwanted pieces, and how to raise it.",
  refunds:  "How and when The Qala refunds a cancelled or undelivered order.",
};
const PAGE_TITLES = {
  terms: "Terms & conditions", privacy: "Privacy policy",
  shipping: "Shipping & cash on delivery", returns: "Returns & damage",
  refunds: "Refunds & cancellation",
};

/* ---- FAQPage JSON-LD, quoting the live shipping/returns/refunds pages ---
   Not a rewrite: every answer below is the policy page's own wording,
   trimmed of markup. Changing what those pages say and not changing this
   is exactly the drift this generator exists to avoid — so if you change
   the wording in index.html's PAGES.shipping/returns/refunds, change it
   here too. */
const FAQS = {
  shipping: [
    ["Is shipping free?", "Free insured shipping on every order over the shop's free-shipping threshold. Below that it is a flat fee."],
    ["How long does dispatch take?", "Ready pieces leave Pune within two working days. Anything fitted or polished to order takes five to seven days."],
    ["How long does delivery take?", "Two days across most of Maharashtra, three to five days elsewhere in India. Every parcel is insured and tracked, with the tracking link sent on WhatsApp."],
    ["How can I pay?", "Online by UPI, bank transfer or a payment link, in cash at the shop in Dighi, or cash on delivery on pieces marked for it (an extra courier charge applies)."],
  ],
  returns: [
    ["What if my order arrives damaged?", "The Qala replaces or refunds it, provided you send an unbroken opening video — recorded from before the tape is cut until the piece is fully out of the box, in one take — on WhatsApp with your order reference within 48 hours of delivery."],
    ["Can I return a piece I simply don't like?", "No. Each piece is checked, polished and packed by hand before it leaves and cannot be resold as new. A video call before ordering is offered instead, to avoid surprises."],
    ["Can I see a piece before I order?", "Yes — ask for a video call on WhatsApp, or visit the shop in Dighi, Pune during opening hours."],
  ],
  refunds: [
    ["Can I cancel my order?", "Yes, for any reason, any time before it has been handed to the courier — after that it cannot be cancelled because it is already on its way."],
    ["How long does a refund take?", "A refund starts the same working day it is agreed and reaches you through the original payment method within the shop's stated refund window."],
    ["What is refunded if a delivery fails or is cancelled?", "The price of the piece always; shipping too if the fault was the shop's or the parcel arrived damaged. On a cash-on-delivery order there is nothing to refund unless the courier has already been paid."],
  ],
};

/* ---------------------------------------------------------------------- */

const HEAD_REPLACERS = (title, desc, canonical, ogTitle, ogDesc) => [
  ['<title>The Qala — Rajwadi &amp; Victorian Jewellery, Dighi, Pune</title>',
   `<title>${esc(title)}</title>`],
  ['<meta name="description" content="Rajwadi, Victorian and moissanite jewellery, made by hand in Dighi, Pune. Order on WhatsApp.">',
   `<meta name="description" content="${esc(desc)}">`],
  ['<link rel="canonical" href="https://theqalashree.com/">',
   `<link rel="canonical" href="${esc(canonical)}">`],
  ['<meta property="og:url" content="https://theqalashree.com/">',
   `<meta property="og:url" content="${esc(canonical)}">`],
  ['<meta property="og:title" content="The Qala — Rajwadi &amp; Victorian jewellery, Dighi, Pune">',
   `<meta property="og:title" content="${esc(ogTitle)}">`],
  ['<meta property="og:description" content="Thushi, saaj, mangalsutra, bangles and bridal pieces, made by hand and sent insured across India. Order on WhatsApp.">',
   `<meta property="og:description" content="${esc(ogDesc)}">`],
];

const JSONLD_ANCHOR = '  "inLanguage": ["en-IN", "mr-IN"]\n}\n</script>\n';
const VIEW_EMPTY = '<main id="view"></main>';

/* Every image, the logo, the favicon, and — most importantly — the fetch()
   that loads photos/catalogue.json are all written as bare relative paths
   ("photos/catalogue.json", not "/photos/catalogue.json"), because on the
   root page that resolves the same either way. These pages do not live at
   the root: piece/CODE/index.html is one directory deeper, so without this,
   every one of those requests would go looking under piece/CODE/photos/…
   instead — and the app cannot even load its own data. One <base> tag fixes
   every relative reference in the page at once, the same way it would if the
   page really were served from the root. */
const CHARSET = '<meta charset="utf-8">';
const BASE_TAG = `${CHARSET}\n<base href="${SITE}/">`;

function buildPage(master, {title, desc, canonical, ogTitle, ogDesc, ogImage, jsonld, hash, innerHTML}) {
  if (!master.startsWith(CHARSET)) throw new Error("expected file to open with the charset meta tag");
  let out = BASE_TAG + master.slice(CHARSET.length);
  for (const [from, to] of HEAD_REPLACERS(title, desc, canonical, ogTitle, ogDesc)) {
    if (!out.includes(from)) throw new Error("head anchor not found: " + from.slice(0, 60));
    out = out.replace(from, to);
  }
  if (ogImage) {
    out = out.replace(
      '<meta property="og:image" content="https://theqalashree.com/photos/logo-square.jpg">',
      `<meta property="og:image" content="${esc(ogImage)}">`);
  }
  if (!out.includes(JSONLD_ANCHOR)) throw new Error("json-ld anchor not found");
  const blocks = jsonld ? (Array.isArray(jsonld) ? jsonld : [jsonld]) : [];
  const ldBlock = blocks.map(b =>
    `<script type="application/ld+json">\n${JSON.stringify(b, null, 2)}\n</script>\n`).join("");
  out = out.replace(JSONLD_ANCHOR, JSONLD_ANCHOR + ldBlock);

  /* Set before any of the app's own scripts run, so the very first render()
     call — which happens once photos/catalogue.json has loaded — reads this
     hash and draws this page. The app's router is not touched at all. */
  out = out.replace('<title>', `<script>if(!location.hash)location.hash=${JSON.stringify("#" + hash)};</script>\n<title>`);

  if (!out.includes(VIEW_EMPTY)) throw new Error("#view anchor not found");
  out = out.replace(VIEW_EMPTY, `<main id="view">${innerHTML}</main>`);

  return out;
}

/* ---------------------------------------------------------------------- */

async function main() {
  const master = read("index.html");
  const browser = await chromium.launch();
  const page = await browser.newPage({viewport: {width: 1280, height: 900}});

  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));

  const renderRoute = async (hash) => {
    /* Not "networkidle" — the app pings analytics and Google Fonts, which
       this sandbox's network policy blocks outright, and a blocked request
       that keeps retrying never goes idle. "load" plus an explicit wait for
       the loading skeleton to clear is what actually happens in a browser
       with a normal connection. */
    await page.goto(BASE + "/#" + hash, {waitUntil: "load", timeout: 20000});
    /* The app paints a loading skeleton until the catalogue has loaded, then
       repaints for real — wait for that second paint rather than a fixed
       delay, which either races it on a slow run or wastes time on a fast
       one. */
    await page.waitForFunction(() => !document.querySelector(".skelgrid"), {timeout: 15000}).catch(() => {});
    await page.waitForTimeout(150);
    const title = await page.title();
    const desc  = await page.$eval('meta[name="description"]', el => el.content).catch(() => "");
    const innerHTML = await page.$eval("#view", el => el.innerHTML);
    return {title, desc, innerHTML};
  };

  const written = [];

  /* ---- one page per product ------------------------------------------ */
  for (const cat of CATALOGUE.categories) {
    for (const pr of cat.products) {
      const code = pr.code;
      const slug = code.toLowerCase();
      const hash = "/piece/" + encodeURIComponent(code);
      const canonical = `${SITE}/piece/${slug}/`;
      const name = pr.title && pr.title.trim() ? pr.title.trim()
        : `${catName(cat.slug).en} ${pr.n}`;
      const {title, desc, innerHTML} = await renderRoute(hash);

      const image = pr.images && pr.images[0]
        ? `${SITE}/${String(pr.images[0]).split("/").map(encodeURIComponent).join("/")}` : undefined;
      const qty = pr.sizes && Number.isFinite(pr.sizes.qty) ? pr.sizes.qty : 1;
      const jsonld = {
        "@context": "https://schema.org",
        "@type": "Product",
        "@id": canonical + "#product",
        "name": name,
        "sku": code,
        "url": canonical,
        "image": image ? (pr.images.length > 1
          ? pr.images.map(im => `${SITE}/${String(im).split("/").map(encodeURIComponent).join("/")}`)
          : [image]) : undefined,
        "description": desc || `${name} — handmade ${catName(cat.slug).en.toLowerCase()} jewellery from The Qala, Dighi, Pune.`,
        "category": catName(cat.slug).en,
        "brand": {"@type": "Brand", "name": "The Qala"},
        "offers": {
          "@type": "Offer",
          "url": canonical,
          "priceCurrency": "INR",
          "price": String(pr.price),
          "availability": qty > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
          "itemCondition": "https://schema.org/NewCondition",
          "seller": {"@id": `${SITE}/#shop`},
        },
      };

      write(`piece/${slug}/index.html`, buildPage(master, {
        title, desc: desc || jsonld.description, canonical,
        ogTitle: title, ogDesc: desc || jsonld.description, ogImage: image,
        jsonld, hash, innerHTML,
      }));
      written.push({type: "piece", code, path: `piece/${slug}/`, canonical, title});
    }
  }

  /* ---- one page per category ------------------------------------------ */
  for (const cat of CATALOGUE.categories) {
    const hash = "/shop?c=" + encodeURIComponent(cat.slug);
    const canonical = `${SITE}/shop/${cat.slug}/`;
    const {title, desc, innerHTML} = await renderRoute(hash);
    const info = catName(cat.slug);
    const cover = cat.cover ? `${SITE}/${String(cat.cover).split("/").map(encodeURIComponent).join("/")}` : undefined;
    const items = cat.products.map(pr => ({
      "@type": "ListItem",
      "position": pr.n,
      "url": `${SITE}/piece/${pr.code.toLowerCase()}/`,
      "name": pr.title && pr.title.trim() ? pr.title.trim() : `${info.en} ${pr.n}`,
    }));
    const jsonld = {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      "@id": canonical + "#collection",
      "name": `${info.en} — The Qala`,
      "url": canonical,
      "description": info.blurb || `${info.en} jewellery, handmade in Dighi, Pune.`,
      "isPartOf": {"@id": `${SITE}/#shop`},
      "mainEntity": {
        "@type": "ItemList",
        "numberOfItems": items.length,
        "itemListElement": items,
      },
    };
    write(`shop/${cat.slug}/index.html`, buildPage(master, {
      title, desc: desc || jsonld.description, canonical,
      ogTitle: title, ogDesc: desc || jsonld.description, ogImage: cover,
      jsonld, hash, innerHTML,
    }));
    written.push({type: "category", slug: cat.slug, path: `shop/${cat.slug}/`, canonical, title});
  }

  /* ---- the five policy pages ------------------------------------------ */
  for (const r of ["terms", "privacy", "shipping", "returns", "refunds"]) {
    const hash = "/" + r;
    const canonical = `${SITE}/${r}/`;
    const {title, innerHTML} = await renderRoute(hash);
    const desc = POLICY_META[r];

    let jsonld = {
      "@context": "https://schema.org",
      "@type": "WebPage",
      "@id": canonical + "#page",
      "name": PAGE_TITLES[r],
      "url": canonical,
      "description": desc,
      "isPartOf": {"@id": `${SITE}/#shop`},
    };
    if (FAQS[r]) {
      jsonld = [jsonld, {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "mainEntity": FAQS[r].map(([q, a]) => ({
          "@type": "Question", "name": q,
          "acceptedAnswer": {"@type": "Answer", "text": a},
        })),
      }];
    }
    write(`${r}/index.html`, buildPage(master, {
      title, desc, canonical, ogTitle: title, ogDesc: desc,
      jsonld, hash, innerHTML,
    }));
    written.push({type: "policy", route: r, path: `${r}/`, canonical, title});
  }

  await browser.close();

  fs.writeFileSync(path.join(ROOT, "prerender-report.json"), JSON.stringify(written, null, 2));
  console.log(`wrote ${written.length} pages`);
  console.log(`  pieces:     ${written.filter(w => w.type === "piece").length}`);
  console.log(`  categories: ${written.filter(w => w.type === "category").length}`);
  console.log(`  policy:     ${written.filter(w => w.type === "policy").length}`);
  if (errors.length) {
    console.log(`\n${errors.length} page error(s) seen in the browser during rendering:`);
    for (const e of errors.slice(0, 10)) console.log("  " + e);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
