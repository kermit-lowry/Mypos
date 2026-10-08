# Where things stand

Branch: `claude/pos-foundation`. Everything below is pushed. Run it with the
Quick start in the README; the dev database has an owner (web password
`owner-password-123`, PIN 1111), a manager (2222), a cashier (3333), two
locations, sample sales, purchase orders, transfers, vendors and brands.

## What was built in this round

**Items, brands and vendors**
- Brands are real records: typed once on a product ("nike", "Nike", "NIKE"
  are one brand), listed with product counts, renamed on every product at
  once, or merged. The register's filter panel has Brand chips that combine
  with size / grade / condition ("every Nike in 10 and 10.5, in stock").
- An item can have several vendors, each with the vendor's item number,
  price, lead time, and one preferred vendor. Placing a PO links the vendor
  automatically; receiving records what they actually charged. Reorder
  suggestions name vendors and can be limited to one vendor; the PO item
  search can show only that vendor's items; search finds items by vendor SKU.
- Every item-level report takes brand / vendor / category / product-type
  filters, inventory value groups by category or brand, and there is a
  by-vendor sales report.

**Back office (website)** — modelled on app.lifelongpos.com
- Grouped sidebar: Dashboard · Sales (Orders, Reports) · Inventory (Products,
  Brands) · Purchase (Purchase Orders, Vendors, Purchase Report) · Transfers
  (Transfers, Transfer Report) · Customers · Employees · Marketing (Deals,
  Loyalty) · Settings (Store, Activity log). Slide-in drawer on phones.
- Orders: search by number / customer, status and date filters, full order
  detail with payments and totals, receipt reprint, PIN-guarded refunds.
- Purchase orders: filters, reference / expected / shipping, "only this
  vendor's items" when adding, reorder suggestions, receiving with the
  invoice's unit cost and a packing-slip reference, deliveries history,
  printable PO. Vendor editor with account #, contact, website, address,
  default category, the items it supplies (editable SKU / cost / preferred)
  and its POs.
- Transfers: filters, reference / expected date, send → receive with
  shortages logged, printable slip and shelf labels priced for the
  destination.
- Reports: grouped chips, item filters, Purchases and Transfers reports,
  CSV for everything.

**Permissions and the activity log** — an audit of the whole codebase
(six lenses, every finding checked by two independent reviewers) found 29
gaps; the fixes are in this branch:
- Opening the cash drawer through a receipt reprint now needs the No-sale
  permission/PIN unless it is your own cash sale from the last few minutes,
  and every drawer open is logged.
- A manager's PIN for a 15% discount no longer unlocks any larger discount.
- Failed manager-PIN attempts and sign-in lockouts are logged.
- A manager with staff access can no longer raise their own limits, drop
  owner-set restrictions, promote staff above their own level, or reset
  another manager's PIN; employee changes are logged with before → after.
- Removing someone's back-office access now ends their website session.
- The raw request log never stores PINs, passwords, or gift card codes.
- Named, readable log events for everything the back office changes
  (settings, deals, discount reasons and buttons, categories, loyalty,
  products, brands, vendors, terminals, gift cards, balance adjustments,
  preorder cancellations, consignor payouts, bulk repricing) with filters
  in the Activity log.
- Register: a cart survives switching tabs and reloads; signing out with a
  full cart goes through the same cart-delete permission and log entry;
  store credit as a tender respects its permission; "Change price" on a
  cart line exists and uses the price-override permission; the trade-in
  "resells for" figure can't be raised past the catalog without the
  override PIN.
- Owners can set website passwords from the Employees screen; everyone can
  change their own.

**Shifts, daily close-out and the time clock**
- Start shift (float counted by denomination), paid in / out / safe drops
  with a manager PIN for cashiers, X report, blind close with a variance
  alert that needs a manager's approval, stored and printable Z report.
- Cash from sales, refunds, trade-in payouts and preorder deposits lands in
  the register's open drawer; a store can refuse cash without an open drawer.
- Back office: daily close-out checklist, drawer session history, Shifts
  and Daily close reports; Store settings for the three drawer options.
- Time clock: PIN clock in/out on the register's sign-in screen, Shift tab
  and header; timesheets with manager edits, hours and sales-by-shift
  reports, CSV.

**Layaway**
- Sell screen → Layaway: deposit (min % per store), due date, notes; the
  stock is held and prices locked. Layaways tab: payments, pick up (creates
  the sale), cancel with fee and refunds (PIN), printable statements.
- Back office: Layaways page (overdue flags, extend, notes, cancel), customer
  layaways, layaway liability report, terms in Store settings.

**Online orders on the register**
- A new web / marketplace order rings the register (chime, vibration on
  Android), shows a toast with the customer, item count and pickup or ship,
  and the Online tab counts it. Open it: acknowledge, tick items as they're
  set aside, print a pick ticket, mark ready, then "Picked up" (confirm the
  name) or "Ship" with carrier and tracking. Problems get a note and can be
  reopened; the timeline shows who did what. Two registers can't take the
  same step twice.
- Storefront checkout asks for pickup or shipping; shipping is a flat rate
  with an optional free-over amount, set under Store settings → Online
  orders, with pickup instructions.
- Back office: Orders page filters (online only / pickup / ship / new /
  ready / done / problem) with the same actions, a dashboard tile, an
  online-orders report (time to ready, time to done, by channel), and the
  activity log reads "Set aside 2 of 3 items on order #12".

**Employee tasks**
- Back office → Employees → Tasks: define tasks that repeat every day,
  weekly on chosen days, or monthly on a day of the month (or one time), due
  by a time, for one store or all, assigned to anyone / a role / a person,
  with checklist steps and an optional required note. Today's board per
  store (complete, skip, reopen), history with CSV, completion report.
- Register: after the PIN, a briefing lists today's and overdue tasks; the
  Tasks tab and header badge count them; steps tick off, Done takes a note,
  Skip needs a reason and a manager's PIN for cashiers; managers see
  everyone's tasks and can reopen. The website shows a reminder banner after
  login. Every create / change / complete / skip / reopen is in the activity
  log. 43 permissions now (Create and assign employee tasks; Skip a task).

## First things to try on real hardware
1. PAX terminal + Handpoint keys in `.env`, run a $1 sale and a refund.
2. ESC/POS receipt printer with the drawer plugged in: cash sale pops the
   drawer; "No sale" asks for a PIN as a cashier.
3. Zebra label printer: print a shelf label; check the barcode scans.
4. Camera barcode scan and a USB scanner in scanner mode on the Android unit.
