# MyPOS

Point of sale for TCG and sneaker/streetwear shops: one inventory shared by the
in-store register, a built-in web store, and outside channels (Shopify,
TCGplayer, eBay).

```
apps/api        Node + Fastify + Prisma/Postgres. All business logic lives here.
apps/register   Expo / React Native register app for iPad (landscape).
packages/shared Pricing math, money helpers, and request schemas used by both.
```

## Quick start

```bash
pnpm install
docker compose up -d db                     # or any Postgres 16
cp apps/api/.env.example apps/api/.env
pnpm --filter @mypos/shared build
pnpm --filter @mypos/api db:migrate
pnpm --filter @mypos/api db:seed            # staff: owner@/manager@/cashier@mypos.local, PIN 1234
pnpm dev:api                                # http://localhost:4000
pnpm dev:register                           # Expo; open on an iPad or simulator
```

Tests run against a real Postgres (`mypos_test` by default, override with `TEST_DATABASE_URL`):

```bash
pnpm test
```

## What's in it

| Area | What it does |
| --- | --- |
| **Catalog** | Products with variants. TCG singles carry game/set/collector #, condition (NM–DMG) and finish; sneakers/apparel carry size, colorway, DS/VNDS/used, and can be one-of-one (`serialized`). Barcode/SKU/name/set/style-code search. |
| **Inventory** | Per-location stock with an append-only movement log. Decrements are conditional updates, so two registers can't both sell the last copy. Weighted-average cost. |
| **Pricing** | Market prices from Scryfall (MTG) and pokemontcg.io (Pokémon), condition-adjusted, with price history. Variants marked `autoPrice` follow the market through the store's price rule (markup, .99 rounding, floor). |
| **Checkout** | Split tenders: card, cash (with change), store credit, gift card. Idempotency keys make retries safe. Cards are charged first; if anything after that fails, the charge is voided automatically. |
| **Refunds** | Per-line, partial, restock or not, back to original tenders (card first) or to store credit. Tax is refunded proportionally. |
| **Buylist** | Quote cash vs. credit (default 50% / 65% of market), manager approves payout, seller ID recorded, stock received at the offer as cost. |
| **Consignment** | Consignor commission %, floor price (cashiers can't sell below it), FIFO attribution, payouts owed / settled, reversed on refund. |
| **Authentication** | Pass/fail/inconclusive records with method, notes, photos, per item. |
| **Events** | Tournaments with capacity and entry fee; entries ring up like any item and create the registration. Roster with player IDs and check-in. |
| **Preorders** | Allocation and per-customer limits, deposits, balance collected at pickup, cancel to card or store credit. |
| **Storefront** | Public `/storefront/*` API: browse products published to `STOREFRONT`, card-only checkout against the same inventory. |
| **Channels** | Pushes available quantities to Shopify/eBay/TCGplayer and imports their paid orders (idempotent). |
| **Reports** | Daily totals by tender, by product type (with cost), and buylist payouts. |
| **Staff** | Email + PIN login, roles CASHIER < MANAGER < OWNER. Price overrides, refunds, buylist payouts and inventory adjustments need a manager. Consignor settlement needs the owner. |

## Payments

Payments go through `apps/api/src/payments/gateway.ts`, a small interface
(`sale`, `refund`, `void`). Pick one with `PAYMENT_GATEWAY`:

- `mock` — for dev and tests. Token `tok_decline` declines.
- `nmi` — NMI Direct Post with Collect.js tokens. Also works for NMI white-label gateways (change the endpoint).
- `authorizenet` — Authorize.net with Accept.js opaque data (`descriptor:value`).

To add another processor, implement the interface and register it in `payments/index.ts`.

## Not done yet

- **Card-present terminals.** The interface takes a `terminalId`, but no real
  terminal is wired up yet. This depends on which devices and processor you use.
- **TCGplayer.** Inventory push follows TCGplayer's published API but hasn't
  been tested against a live seller account. Order import isn't built yet.
  Their API is invite-only.
- **Shopify and eBay** adapters are written against their current REST APIs
  but haven't been run against live stores.
- **Web store front end.** The storefront API exists; there's no customer-facing site yet.
- **Offline mode** for the register, receipt printing, cash drawer, and a back-office web admin.
- Channel sync runs from `POST /channels/sync`. Run it on a schedule (cron) in production.
