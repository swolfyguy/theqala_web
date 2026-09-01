# The Qala — storefront

The website for The Qala, a Rajwadi, Victorian and moissanite jewellery brand
in Dighi, Pune. One HTML file, a folder of photographs, and a small script that
turns the folders into the shop.

There are two ways to order, side by side on every piece and in the bag:

- **Order now** — she fills in name, WhatsApp number, pincode and address, and
  the whole order opens in WhatsApp already written out. She taps send.
- **Order on WhatsApp** — straight into the chat with just the piece and the
  price band, for someone who would rather ask first.

There is no payment gateway and no orders database. Nothing reaches you until
that WhatsApp message is actually sent — the confirmation screen says so and
repeats the button in case she closed the tab.

Her details are remembered in her own browser, so a returning customer does not
retype them.

---

## One folder is one product

You never list a product anywhere. **The folder is the product, and its name
starts with the price.**

```
photos/
  hero.mp4                                  plays when the site opens
  hero-1.jpg                                still, used if there is no video
  catalogue.json                            generated — keep it in git

  rajwadi/
    cover.jpg                               the tile for this category
    2300 Kolhapuri Thushi/                  ONE PRODUCT
        1.jpg  2.jpg  3.jpg                 every angle, shown in this order
        video.mp4                           optional, appears in the gallery
    3100 Peshwai Saaj/
        1.jpg
```

The price band is worked out from the price: **2,300 shows under ₹2,000 – ₹3,000,
3,100 under ₹3,000 – ₹4,000.** You never make band folders. The customer sees
the exact price; the band is only the filter in the sidebar.

The name after the price is optional — `photos/bangles/4750/` is a perfectly
good product, it just shows as "Bangles 03" instead of a name.

**Filenames inside the folder do not matter.** The studio writes them as
1.jpg, 2.jpg… so the order is explicit, but anything works; they are shown in
filename order and the first one is the cover.

### Reference codes never move

Each product keeps a small hidden `.id` file with its number, so
`RAJWADI-07` stays `RAJWADI-07` when you change its price or rename it — which
matters, because that code is what customers send you on WhatsApp. Numbers of
deleted products are retired and never handed out again.

### Adding and deleting products, day to day

**Double-click `preview.bat`.** It starts the studio on this computer and opens
it. To add a piece: choose the category, type the price, optionally a name, drop
in every photograph you have of it plus a video if you have one, and press
**Save the product**.

- Photographs are shrunk in the browser before anything is written.
- The first one is the cover; the ↑ ↓ buttons reorder them.
- One video per product. Keep it under about 4 MB.

The **Manage** tab lists every product with its code, name and price.
**Price / name** renames the folder and re-files it under the right band without
changing the code. **Add views** appends more photographs. **Delete** removes the
whole folder.

**Commit and push, one button.** The strip across the top shows how many changes
are waiting. Type a message if you want one and press **Commit & push**; "what
changed?" lists the files first. The first push needs git to already know your
GitHub credentials — if you have pushed from that computer before, it just works.

Nothing else on your network can reach the studio — the server only answers to
this computer.

**The studio is never deployed.** `admin.html`, `studio.py` and `preview.bat`
are in `.gitignore`, so they stay on your disk and never reach the repository —
and what is not in the repository cannot be published by Cloudflare Pages.

### Doing it by hand instead

Make the folder yourself and drop the pictures in:

```
photos\rajwadi\2300 Kolhapuri Thushi\
```

then run `python build_catalogue.py --optimize` (or just start `preview.bat`,
which does it). `--optimize` resizes anything wider than 1400px or over 400 KB
in place — worth running before you commit, because the originals live in the
repository forever.

The script tells you what it found and warns about anything it could not read:

```
photos/catalogue.json: 12 products, 31 files, 4 categories
  rajwadi              7 product(s), ₹850–₹9,800
```

Any image format works — jpg, png, webp and the rest go straight on the page;
`.heic` (what an iPhone shoots), `.tif` and `.bmp` are converted to jpg for you.

### Previewing

`preview.bat` serves the shop at `http://localhost:8000/` and the studio at
`http://localhost:8000/admin.html`. To see it on your phone, run `ipconfig`,
take the **IPv4 Address**, and open `http://<that address>:8000` on the phone.

**Do not just double-click `index.html`** — the page reads `catalogue.json` over
HTTP and browsers block that on a `file://` address.

---

## The two lines at the top of `index.html`

```js
const WA   = "919579628754";   // your WhatsApp number — already set
const SITE = "";               // -> "https://theqala.com/" once you have it
```

`SITE` is what puts a **direct link to each piece** inside every WhatsApp order,
so you can tap it and see exactly what she is asking about. Left empty, the link
is built from whatever address the page is open at — right once the site is
live, but it says `localhost` while you preview.

---

## The opening video (optional)

Put a file at **`photos/hero.mp4`** and it plays the moment the home page
opens — inside the arch frame, silent, looping, with a small pause button. No
file there and `photos/hero-1.jpg` shows instead.

| | |
|---|---|
| Length | 8–15 seconds. It loops; nobody watches it twice. |
| Shape | Portrait, roughly 4:5 |
| Sound | None. Browsers block autoplay on anything with sound. |
| Size | Under about 4 MB. Cloudflare Pages refuses any file over 25 MB. |
| Format | `.mp4`, H.264 — what your phone records and every browser plays. |

Compressing a phone clip:

```
ffmpeg -i clip.mp4 -t 12 -an -vf "scale=-2:1000,fps=25" \
       -c:v libx264 -crf 28 -preset slow -movflags +faststart \
       photos/hero.mp4
```

`-t 12` trims, `-an` strips audio, `-crf 28` sets quality (raise to 30 if the
file comes out over 5 MB), `+faststart` lets it play before it finishes
downloading. Avoid cuts — it loops every few seconds and cuts look like a
glitch.

Anyone whose device is set to reduce motion gets the still photo instead.

---

## The domain

Buy it wherever is cheapest — GoDaddy's first-year promos are genuinely low —
and host on Cloudflare Pages. The two are separate jobs and it is normal to mix
them. **Skip every add-on at the registrar**: no hosting, no SSL, no web
security. You need the domain and nothing else.

1. Create a free Cloudflare account → **Add a site** → your domain → Free plan.
   It hands you two nameservers.
2. At GoDaddy: **My Products → Domain → DNS → Nameservers → Change → I'll use
   my own** → paste those two.
3. Wait — usually 10–30 minutes.
4. Cloudflare Pages → your project → **Custom domains** → add `theqala.com` and
   `www.theqala.com`. SSL is issued automatically.
5. Set `const SITE = "https://theqala.com/";` in `index.html`, and make the
   `og:image` tag a full address.

Moving the nameservers rather than adding a single DNS record matters: a CNAME
cannot sit on a root domain, so the record-only route would leave you stuck on
`www.` forever.

**If you ever put email on this domain**, set it up in Cloudflare's DNS panel
after the move, not GoDaddy's. Changing nameservers does not carry mail records
across, and that is the usual way people accidentally kill their own email.

You do not need the domain to go live. Deploy first and the site runs on a free
`your-project.pages.dev` address; add the domain whenever you are ready.

---

## Deploying

Cloudflare Pages, free tier — unlimited bandwidth, free SSL, custom domain.

1. Push this repo to GitHub.
2. Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git.
3. Pick this repo. **Framework preset: None. Build command: leave empty.
   Output directory: `/`.**
4. Add your domain under Custom domains. SSL is automatic.

Every push redeploys in about 30 seconds, and Cloudflare keeps every previous
deployment, so a bad change is one click to roll back.

Do not use Vercel's free Hobby tier — its terms forbid commercial use.

> If you would rather not use the GitHub Action, set Cloudflare's build command
> to `python3 build_catalogue.py` and delete `.github/workflows/catalogue.yml`.
> Same result, one less moving part, but the catalogue is no longer visible in
> the repo.

---

## Running cost

The domain, and nothing else.

| | |
|---|---|
| Domain (.com) | ₹1,000–1,500 / year at renewal |
| Cloudflare Pages hosting | ₹0 |
| GitHub Actions | ₹0 on public repos, and well inside the free minutes on private |
| Payment gateway | ₹0 — there isn't one |
| WhatsApp | ₹0 — plain `wa.me` links |

---

## What this site deliberately does not do

No orders database, no inventory count, no admin panel, no analytics. Every
order lives in your WhatsApp chat. That is fine at 20–40 orders a month and
painful past 100 — at that point the next step is Razorpay payment links sent
in the chat, which needs no change to this site.
