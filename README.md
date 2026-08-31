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

## The folders are the shop

You never list a product anywhere, and **filenames do not matter.** Drop
photographs in straight off your phone. The folder decides the category and the
price band; the script hands out the numbers.

```
photos/
  hero.mp4                              plays when the site opens
  hero-1.jpg                            still picture, used if there is no video
  catalogue.json                        generated — do not edit by hand

  rajwadi/
    whatever-you-like.jpg               the category tile (any loose image here)
    2000-3000/
      IMG_4432.jpg                      -> RAJWADI-2000-1
      WhatsApp Image 2026-08-29.jpeg    -> RAJWADI-2000-2
      thushi shoot/                     -> RAJWADI-2000-3
        IMG_5501.jpg                       all three are views
        IMG_5502.jpg                       of that one piece
        IMG_5503.jpg
```

**The rules — all of them**

1. Category folder, then a price folder named `low-high` (e.g. `3000-4000`).
2. One loose image = one piece. Call it anything.
3. Several photos of the *same* piece? Put them in a subfolder together. The
   folder can be called anything too; the first image alphabetically is the
   one shown on the shop page.
4. **Any image format.** `.jpg` `.jpeg` `.png` `.webp` `.avif` `.gif` `.svg`
   go straight on the page. `.heic` — what an iPhone shoots by default —
   plus `.tif` `.tiff` `.bmp` are **converted to `.jpg` automatically**,
   because no browser can display them. Upper or lower case, doesn't matter.

Customers see the photo, the reference code (`RAJWADI-2000-1`), the category and
the price band. The exact price is settled on WhatsApp — the code is what they
send you.

### The numbers never move

A number is handed out the first time the script sees a file, and then it is
that piece's number forever.

- Add a photo whose name sorts before everything else: it gets the **next**
  number, not number 1. Nothing renumbers.
- Delete a piece: its number is retired and never handed out again, so an old
  WhatsApp conversation about `RAJWADI-2000-3` can never point at a different
  necklace later.

The one thing to avoid is **renaming a file after it has gone live** — to the
script that is a delete plus a new upload, so it gets a fresh number. Since
names don't matter, there is no reason to rename.

**New folders need no code change.** Make `photos/rajwadi/6000-8000/`, drop
photos in, and a `₹6,000 – ₹8,000` filter appears on the shop page. Add a whole
new category folder and it shows up too — the only thing worth adding then is
its Marathi name in `CAT_NAMES` at the top of `index.html`.

### Adding and deleting pieces, day to day

**The studio page — `admin.html`**

Open `admin.html`, connect it once to your repository, and after that adding a
piece is: pick the category and price band, drag the photos in, press
**Commit to GitHub**. It shrinks every photograph in the browser first, then
writes them all as a single commit. The Action rebuilds the catalogue and
Cloudflare redeploys, exactly as if you had used github.com.

The **Manage** tab lists everything in the shop with its real reference code,
and gives each piece a Delete and a Move button. Deleting a piece with several
views removes all of them in one commit.

*Connecting it, once:* on GitHub go to
Settings → Developer settings → **Fine-grained tokens** → generate one scoped to
**only this repository** with **Contents: Read and write**, and an expiry. Paste
it into the studio's Settings tab. It is saved in that browser's storage only —
never in the repository, never sent anywhere but GitHub. Lose the laptop, or
paste it somewhere careless, and you delete the token on GitHub; it stops
working immediately.

`admin.html` deploys with the site, so you can reach it from your phone. It is
inert without a token, and carries a `noindex` tag so search engines skip it.
If you would rather it never be public at all, delete the file from the repo and
open your local copy instead — it works the same from `file://`.

**Or github.com directly — no git, no laptop needed**

1. Open your repository on github.com and click into
   `photos/` → the category → the price folder.
2. **Add file → Upload files**, drag the photographs in, type a short message,
   **Commit changes**.
3. That is the whole job. The Action shrinks anything oversized, renumbers
   nothing that already exists, gives the new photos the next free numbers, and
   Cloudflare redeploys. About a minute.

**Deleting a piece** — open the photo in github.com, click the bin icon, commit.
It disappears from the shop on the next deploy, and its code is retired for
good so an old WhatsApp conversation can never point at a different necklace.

**Moving a piece to a different price** — open it, **⋯ → Move file**, change the
folder in the path box, commit. It gets a new code, because the code contains
the price band.

**From your laptop instead** — drop the files into the folders, double-click
`preview.bat` to check them, then `git add . && git commit -m "new pieces" &&
git push`. Better for a batch of twenty; overkill for one.

One habit worth keeping either way: **shrink before you upload** when you can.
The Action shrinks photos in the working tree, but git keeps the original heavy
file in its history forever. `preview.bat` does the shrinking for you.

### Checking your work before you push

```
python3 build_catalogue.py
```

It prints what it found and warns about anything it needs you to look at — a
folder that isn't a price range, a photo still too heavy, a `.heic` it could
not read:

```
photos/catalogue.json: 40 pieces, 68 photos, 6 categories
  rajwadi              1000-2000: 3, 2000-3000: 5, 3000-4000: 4
  ...
```

`photos/catalogue.json` is where the number assignments live, so **it belongs in
git** — never delete it, or every piece gets renumbered from 1.

### Previewing locally

**Double-click `preview.bat`.** It rebuilds the catalogue, starts a small web
server and opens `http://localhost:8000` in your browser. Leave the black
window open while you look; Ctrl+C in it stops the preview.

Refresh the browser to see changes. If you added photos while it was running,
close the window and double-click `preview.bat` again so the catalogue is
rebuilt.

Doing it by hand instead:

```
cd C:\Users\admin\claude_projects\the-qala-site
python build_catalogue.py --optimize
python -m http.server 8000
```

then open `http://localhost:8000`.

**Do not just double-click `index.html`.** The page reads `catalogue.json` over
HTTP, and browsers block that on a `file://` address — the shop will look
empty and tell you so.

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
