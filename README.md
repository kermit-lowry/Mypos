# MyPOS

Point of sale for TCG and sneaker/streetwear shops: one inventory shared by the
in-store register, a built-in web store, and outside channels (Shopify,
TCGplayer, eBay).

```
apps/api        Node + Fastify + Prisma/Postgres. All business logic lives here.
apps/register   Expo / React Native register app: iPad, Android tablets, and Android POS hardware.
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
pnpm dev:register                           # Expo; open on an iPad, Android device, or simulator
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
| **Loyalty** | The owner picks one of two types. **Cashback:** a set % of every pre-tax dollar becomes rewards dollars, spent like a tender. **Points:** points per dollar, spent on rewards the owner defines: % off (optional cap), $ off, or a specific item free or $X off. The owner can exclude product types (e.g. event entries) and decide whether purchases paid with store credit earn. Rewards are applied before tax. Refunds take back exactly what the returned items earned, and give back redeemed points on a full return. Online orders earn; rewards are redeemed at the register. |
| **Dual pricing** | The owner sets a card-price percentage per location (e.g. 3.99%). Every item has a cash price and a card price (cash + %), shown side by side on the register, the customer display, receipts, and shelf labels. Card payments pay the card price; cash, store credit, gift cards and rewards pay the cash price; split payments prorate. Tax is charged on the price paid. Refunds return what was paid, and the daily report shows the card-price total and the tax on it. The web store shows and charges card prices. |
| **Customer display** | A second tablet in Display mode shows the cart with cash and card prices, totals at both, amount due while paying, loyalty, and change. It pairs with a register through its card terminal. |
| **Receipts** | Plain text (thermal printers), HTML (AirPrint/email), or printed on the PAX terminal's printer through Handpoint. Shows cash and card totals and the % difference. Header/footer set by the owner. |
| **Labels** | 2.25" x 1.25" shelf labels with cash and card prices and a scannable barcode. Sent straight to a network Zebra (ZPL) printer, or printed through AirPrint. |
| **Storefront** | Public `/storefront/*` API: browse products published to `STOREFRONT`, card-only checkout against the same inventory. |
| **Channels** | Pushes available quantities to Shopify/eBay/TCGplayer and imports their paid orders (idempotent). |
| **Reports** | Daily totals by tender, by product type (with cost), and buylist payouts. |
| **Staff** | Email + PIN login, roles CASHIER < MANAGER < OWNER. Price overrides, refunds, buylist payouts and inventory adjustments need a manager. Consignor settlement needs the owner. |

## Hardware

The register runs on **iPad and Android**: tablets, phones, and Android POS
hardware such as Sunmi, iMin, PAX, and Elo devices. It works in portrait and
landscape. On small screens (handhelds like the PAX A920 or Sunmi V2) the
search and cart become two tabs.

| Hardware | How it connects |
| --- | --- |
| Card reader | PAX terminal through Handpoint (see Payments). |
| Barcode scanner | Built-in, USB, or Bluetooth scanners in keyboard mode: scan into the search box; it stays focused for back-to-back scans. On Android, the ⌨ button turns off the on-screen keyboard for devices with a built-in scanner. The camera also scans. |
| Receipt printer | Network ESC/POS printers (Epson TM, Star in ESC/POS mode, most 80mm/58mm printers), set per register with `PATCH /terminals/:id` (`receiptPrinterHost`). Falls back to the PAX terminal's printer, or the system print dialog (AirPrint / Android print service). |
| Cash drawer | Plugged into the receipt printer; pops automatically on cash sales. Managers can "No sale" open it. |
| Label printer | Network Zebra (ZPL) printer, set per location. |
| Customer display | A second tablet or phone in Display mode (iPad or Android). |

**Android and plain HTTP.** Android blocks `http://` connections by default. If
the API runs on your store network without HTTPS, build with
`MYPOS_ALLOW_HTTP=1`. Use HTTPS for anything reachable from the internet.

**Previewing layouts** without a device: `pnpm --filter @mypos/register web` runs
the register in a browser (react-native-web). Resize the window to see phone,
handheld, and tablet layouts. Hardware features (camera, secure storage) are
limited there.

## Payments

In-store cards run on **PAX terminals through Handpoint's Cloud API**. Online
cards (the web store) go through a separate card-not-present processor. A router
(`apps/api/src/payments/router.ts`) picks the processor for each sale and sends
refunds and voids back to whichever one took the original payment.

**In store (Handpoint + PAX).** Set `HANDPOINT_API_KEY` and `HANDPOINT_ENV`
(`development` → cloud.handpoint.io, `production` → cloud.handpoint.com). Then a
manager runs `POST /terminals/sync` to import the merchant's terminals, and each
register picks its terminal once. A sale is sent to that terminal and the server
waits while the customer taps or inserts. If the result never arrives, it asks
Handpoint's status API, which can confirm the card was not charged once 90s
have passed.

When the outcome is genuinely unknown (terminal went offline mid-sale), the sale
is cancelled at the register and the payment is flagged as pending; it is never
treated as a decline. Managers see these at `GET /payments/pending` and
`POST /payments/:id/resolve` looks the payment up: if it was charged, it's voided
on the terminal; if not, it's closed. Partial approvals (US) are released
automatically so the cashier can split the payment. Refunds run on the terminal
that took the payment, or one the manager picks.

Without a Handpoint key, a mock terminal processor approves everything for development.

**Online.** Pick one with `PAYMENT_GATEWAY`:

- `mock`: for dev and tests. Token `tok_decline` declines.
- `nmi`: NMI Direct Post with Collect.js tokens. Also works for NMI white-label gateways (change the endpoint).
- `authorizenet`: Authorize.net with Accept.js opaque data (`descriptor:value`).

To add a processor, implement `PaymentGateway` (`payments/gateway.ts`) and register it in `payments/index.ts`.

## Not done yet

- **Handpoint hasn't been run against a live account or a real PAX terminal.**
  It's built from their REST API 2.30 docs and tested against a scripted fake.
  Results are fetched by polling; Handpoint's callback URL option (needs a public
  HTTPS endpoint) would cut latency slightly. Tipping on the terminal isn't wired up.
- **TCGplayer.** Inventory push follows TCGplayer's published API but hasn't
  been tested against a live seller account. Order import isn't built yet.
  Their API is invite-only.
- **Shopify and eBay** adapters are written against their current REST APIs
  but haven't been run against live stores.
- **Web store front end.** The storefront API exists; there's no customer-facing site yet.
- **Offline mode** for the register, and a back-office web admin.
- **Built-in printers and dual screens on Android POS** (Sunmi, iMin, PAX E-series)
  need the vendor's native SDK in a custom Expo build; today those devices use
  network printers and a second device for the customer display.
- **Not yet run on physical Android hardware.** The Android bundle builds, and
  layouts were checked in a browser at handheld and tablet sizes.
- Channel sync runs from `POST /channels/sync`. Run it on a schedule (cron) in production.
