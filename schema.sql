-- The Qala — order book
--
-- Run this once, after you have created the database:
--     npx wrangler d1 execute qala-orders --remote --file=./schema.sql
-- or paste it into the D1 console in the Cloudflare dashboard.
--
-- It is safe to run again — every statement checks first.

CREATE TABLE IF NOT EXISTS orders (
  ref        TEXT PRIMARY KEY,          -- QALA-2609-4471, made by the website
  placed_at  TEXT NOT NULL,             -- ISO, in UTC
  name       TEXT NOT NULL,
  phone      TEXT NOT NULL,             -- 10 digits, no country code
  pincode    TEXT,                      -- empty when collecting at the shop
  address    TEXT,
  pay        TEXT NOT NULL,             -- online | shop | cod
  poth       TEXT DEFAULT '',           -- poth length in inches, 24 to 40, or empty
  items      TEXT NOT NULL,             -- JSON: [{code,title,qty,price}]
  goods      INTEGER NOT NULL,          -- rupees, before shipping
  shipping   INTEGER NOT NULL DEFAULT 0,
  cod_fee    INTEGER NOT NULL DEFAULT 0,
  total      INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'new',   -- new | confirmed | sent | done | cancelled
  note       TEXT DEFAULT '',
  updated_at TEXT
);

-- The order book is always read newest first.
CREATE INDEX IF NOT EXISTS orders_by_date ON orders (placed_at DESC);
-- And filtered by status.
CREATE INDEX IF NOT EXISTS orders_by_status ON orders (status, placed_at DESC);
-- Used by the flood guard, to count recent orders from one number.
CREATE INDEX IF NOT EXISTS orders_by_phone ON orders (phone, placed_at DESC);


-- Wrong passwords, counted per address so nobody can sit and guess at
-- the password. Rows older than a day are cleared on the next sign-in.
CREATE TABLE IF NOT EXISTS logins (
  at    TEXT NOT NULL,
  ip    TEXT NOT NULL,
  phone TEXT,
  ok    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS logins_by_ip ON logins (ip, at DESC);


-- ---------------------------------------------------------------------
-- Only if you already ran an earlier version of this file: the orders
-- table will exist without the poth column. Run this line on its own.
--
--     ALTER TABLE orders ADD COLUMN poth TEXT DEFAULT '';
--
-- "duplicate column name" back means it is already there — nothing to do.
-- ---------------------------------------------------------------------
