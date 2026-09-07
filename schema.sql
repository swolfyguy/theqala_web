-- The Qala — order book
--
-- Paste the whole of this file into the D1 console and run it, or
--     npx wrangler d1 execute qala-orders --remote --file=./schema.sql
--
-- Safe to run again. Every statement checks first, so nothing is lost
-- and nothing is duplicated.
--
-- No comment in this file contains a semicolon. The D1 console splits
-- what you paste on semicolons WITHOUT ignoring comments, so one inside
-- a comment cuts a statement in half.


CREATE TABLE IF NOT EXISTS orders (
  ref        TEXT PRIMARY KEY,
  placed_at  TEXT NOT NULL,
  name       TEXT NOT NULL,
  phone      TEXT NOT NULL,
  pincode    TEXT,
  address    TEXT,
  pay        TEXT NOT NULL,
  poth       TEXT DEFAULT '',
  items      TEXT NOT NULL,
  goods      INTEGER NOT NULL,
  shipping   INTEGER NOT NULL DEFAULT 0,
  cod_fee    INTEGER NOT NULL DEFAULT 0,
  total      INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'new',
  note       TEXT DEFAULT '',
  source     TEXT NOT NULL DEFAULT 'site',
  photo      TEXT DEFAULT '',
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS orders_by_date ON orders (placed_at DESC);

CREATE INDEX IF NOT EXISTS orders_by_status ON orders (status, placed_at DESC);

CREATE INDEX IF NOT EXISTS orders_by_phone ON orders (phone, placed_at DESC);


CREATE TABLE IF NOT EXISTS order_photos (
  ref  TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  data TEXT NOT NULL
);


CREATE TABLE IF NOT EXISTS here (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS here_by_time ON here (at);


CREATE TABLE IF NOT EXISTS logins (
  at    TEXT NOT NULL,
  ip    TEXT NOT NULL,
  phone TEXT,
  ok    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS logins_by_ip ON logins (ip, at DESC);


-- =====================================================================
-- WHAT THE COLUMNS HOLD
--
-- orders
--   ref         QALA-2609-4471, made by the website or by the office
--   placed_at   ISO timestamp, in UTC
--   phone       10 digits, no country code
--   pincode     empty when they are collecting at the shop
--   pay         online, shop or cod
--   poth        the order's own length. Filled only when the piece has
--               no range of its own, otherwise the first length chosen
--   items       JSON, one entry per piece, holding
--               code, title, qty, price and size. "size" is the poth
--               length chosen for that piece, or empty
--   goods       rupees, before shipping
--   status      new, confirmed, sent, done or cancelled
--   source      site when the customer used the website. Otherwise how
--               they reached us -- whatsapp, instagram, phone or shop.
--               Only "site" orders count against how many are left,
--               because the shop already knows what it has set aside
--   photo       the picture's type when one was sent in, e.g. image/jpeg,
--               and empty when there is none
--
-- order_photos
--   The picture a customer sent on WhatsApp or Instagram, kept apart from
--   the order itself so that listing the book never drags the pictures
--   along. One row per order, base64, deleted with nothing else.
--
-- here
--   Who is on the shop at this moment. One row per open tab, holding a
--   random id that tab made up for itself and the last time it said hello.
--   No address, no name, no cookie, nothing that outlives the visit --
--   rows older than ten minutes are swept away as people come and go.
--
-- logins
--   Wrong passwords, counted per address so nobody can sit and guess.
--   Rows older than a day are cleared away on the next sign-in.
--
--
-- IF YOU RAN AN EARLIER VERSION OF THIS FILE
--
-- Everything above is IF NOT EXISTS, so running it again will add
-- whatever is missing -- including the new order_photos table. The one
-- thing it cannot do is add a column to a table that already exists.
-- Run these three lines, one at a time, without the two dashes in front
--
--     ALTER TABLE orders ADD COLUMN poth TEXT DEFAULT ''
--     ALTER TABLE orders ADD COLUMN source TEXT NOT NULL DEFAULT 'site'
--     ALTER TABLE orders ADD COLUMN photo TEXT DEFAULT ''
--
-- The order_photos and here tables are both IF NOT EXISTS above, so pasting
-- this whole file again is all they need.
--
-- "duplicate column name" back means it was already there, and nothing
-- was harmed by asking. Every order already in the book becomes a "site"
-- order, which is what they all are.
--
--
-- TO SEE WHAT YOU ACTUALLY HAVE
--
--     SELECT name FROM sqlite_master WHERE type = 'table'
--     PRAGMA table_info(orders)
-- =====================================================================
