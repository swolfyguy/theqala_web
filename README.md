# The Qala — storefront

The website for The Qala, a Rajwadi, Victorian and moissanite jewellery brand
in Dighi, Pune. One HTML file plus a folder of photographs — no build step,
no framework, no server.

Orders are placed on WhatsApp. There is no checkout form and no payment
gateway on the site.

---

## Structure

```
index.html                 the whole site
photos/
  rajwadi/
  victorian/
  short-mangalsutra/
  rings/
  necklace/
  heritage/
```

Open `index.html` in any browser to see the site. That's the real thing —
what you see locally is exactly what goes live.

---

## The three things you will actually edit

All three sit at the top of the `<script>` block inside `index.html`.

### 1. Your WhatsApp number

```js
const WA = "919999999999";
```

Country code + number, digits only, no `+` and no spaces.
**Do this first** — every order button on the site uses it.

### 2. Photos

Put each piece's pictures in its category folder, then list them:

```js
const PHOTOS = {
  "thushi-kolhapuri": ["photos/rajwadi/thushi-1.jpg", "photos/rajwadi/thushi-2.jpg"],
  "victorian-choker": ["photos/victorian/choker-1.jpg"],
};
```

The first path is the main picture; the rest become thumbnails on the
product page.

- A piece you have not photographed keeps its drawn illustration.
- A wrong or missing filename falls back to the illustration too — a
  customer never sees a broken image.
- Portrait crops, roughly 4:5. Resize to about 1200px wide and under
  300 KB before committing. A raw phone photo is 4–6 MB and will make the
  shop crawl on mobile data.

### 3. Products

Each piece is one entry in the `PRODUCTS` array:

```js
{id:"thushi-kolhapuri", mr:"कोल्हापुरी ठुशी", en:"Kolhapuri Thushi",
 cat:"rajwadi", art:"thushi",
 price:3450, mrp:4200, badge:"Bestseller",
 material:"Brass base, 1-gram gold micron plating",
 weight:"38 g", size:"11 in + 2 in extender",
 blurb:"..."},
```

- `id` must be unique — it is the URL and the key used in `PHOTOS`.
- `cat` must be one of: `rajwadi`, `victorian`, `short-mangalsutra`,
  `rings`, `necklace`, `heritage`.
- `art` picks the drawn illustration used until a photo exists. Available:
  `thushi`, `saaj`, `mangalsutra`, `vati`, `mohanmal`, `putali`, `lakshmi`,
  `bormaal`, `tanmani`, `chinchpeti`, `vchoker`, `nath`, `bugadi`, `kudi`,
  `jhumka`, `ring`, `vaki`, `set`, `setstone`, `painjan`, `jodvi`, `pin`.
- `mrp: 0` hides the struck-through price and the discount badge.
- `badge: ""` hides the corner label.

Adding a new category means adding it to `CATS` as well, and making the
matching folder under `photos/`.

---

## Deploying

Cloudflare Pages, free tier — unlimited bandwidth, free SSL, custom domain.

1. Push this repo to GitHub.
2. Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git.
3. Pick this repo. **Framework preset: None. Build command: leave empty.
   Output directory: `/`.** It is a static site; there is nothing to build.
4. Add your domain under Custom domains. SSL is automatic.

After that, every `git push` redeploys in about 30 seconds. Cloudflare keeps
every previous deployment, so a bad change is one click to roll back.

Do not use Vercel's free Hobby tier — its terms forbid commercial use.

---

## Running cost

The domain, and nothing else.

| | |
|---|---|
| Domain (.com) | ₹1,000–1,500 / year at renewal |
| Cloudflare Pages hosting | ₹0 |
| Payment gateway | ₹0 — there isn't one |
| WhatsApp | ₹0 — plain `wa.me` links |

---

## What this site deliberately does not do

No orders database, no inventory count, no admin panel, no analytics.
Every order lives in your WhatsApp chat. That is fine at 20–40 orders a
month and painful past 100 — at that point the next step is Razorpay
payment links sent in the chat, which needs no change to this site.
