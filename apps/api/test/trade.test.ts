import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { key, onHand, prisma, seedCatalog, setup, type World } from "./helpers.js";

let w: World;
let v: Awaited<ReturnType<typeof seedCatalog>>;

beforeEach(async () => {
  w = await setup();
  v = await seedCatalog(w);
});
afterAll(() => prisma.$disconnect());

const customer = async (name = "Brock") => (await w.as(w.cashier, "POST", "/customers", { name })).body.id as string;

describe("buylist", () => {
  it("quotes cash and credit, then pays credit and receives stock at cost", async () => {
    const cust = await customer();
    const quote = await w.as(w.cashier, "POST", "/buylist/quote", {
      locationId: w.locationId,
      customerId: cust,
      lines: [
        { variantId: v.nm, quantity: 2, marketCents: 1000 },
        { description: "Bulk commons box", quantity: 1, marketCents: 2000, cashOfferCents: 500, creditOfferCents: 700 },
      ],
    });
    expect(quote.status).toBe(201);
    // Default rule: 50% cash / 65% credit
    expect(quote.body).toMatchObject({ status: "QUOTED", cashTotalCents: 1500, creditTotalCents: 2000 });

    const cashierAccept = await w.as(w.cashier, "POST", `/buylist/${quote.body.id}/accept`, { payout: "STORE_CREDIT" });
    expect(cashierAccept.status).toBe(403);

    const accept = await w.as(w.manager, "POST", `/buylist/${quote.body.id}/accept`, { payout: "STORE_CREDIT", sellerIdType: "DL", sellerIdLast4: "1234" });
    expect(accept.status).toBe(200);
    expect(accept.body).toMatchObject({ status: "ACCEPTED", paidCents: 2000 });
    expect(await onHand(v.nm, w.locationId)).toBe(5);
    expect((await w.as(w.cashier, "GET", `/customers/${cust}`)).body.storeCreditCents).toBe(2000);

    // Cost blends 3 units at unknown (falls back to offer) with 2 bought at $6.50.
    const variant = await prisma.variant.findUniqueOrThrow({ where: { id: v.nm } });
    expect(variant.costCents).toBe(650);

    const twice = await w.as(w.manager, "POST", `/buylist/${quote.body.id}/accept`, { payout: "CASH" });
    expect(twice.status).toBe(409);
  });

  it("requires a customer for store credit payouts", async () => {
    const quote = await w.as(w.cashier, "POST", "/buylist/quote", { locationId: w.locationId, lines: [{ variantId: v.nm, quantity: 1, marketCents: 1000 }] });
    const res = await w.as(w.manager, "POST", `/buylist/${quote.body.id}/accept`, { payout: "STORE_CREDIT" });
    expect(res.status).toBe(400);
  });
});

describe("consignment", () => {
  it("sells a consigned pair, owes the consignor net of commission, and reverses on refund", async () => {
    const cust = await customer("Consignor Carl");
    const consignor = await w.as(w.manager, "POST", "/consignors", { customerId: cust, commissionBps: 2000 });
    const item = await w.as(w.manager, "POST", "/consignment", {
      consignorId: consignor.body.id,
      variantId: v.shoe,
      locationId: w.locationId,
      quantity: 1,
      floorCents: 28000,
    });
    expect(item.status).toBe(200);
    expect(await onHand(v.shoe, w.locationId)).toBe(1);

    const auth = await w.as(w.cashier, "POST", "/authentications", { variantId: v.shoe, result: "PASS", method: "In-hand: tags, stitching, UV" });
    expect(auth.status).toBe(200);

    // A cashier discount that takes the pair below the consignor's floor is blocked...
    const cashierLow = await w.as(w.cashier, "POST", "/orders/checkout", {
      locationId: w.locationId,
      // $25 off a $300 pair is within a cashier's 10% limit, but under the $280 floor.
      lines: [{ variantId: v.shoe, quantity: 1, discountCents: 2500 }],
      tenders: [{ type: "CASH", amountCents: 29769 }],
      idempotencyKey: key(),
    });
    expect(cashierLow.body.error).toBe("BELOW_CONSIGNOR_FLOOR");
    expect(await onHand(v.shoe, w.locationId)).toBe(1);

    // ...but a manager may override it.
    const low = await w.as(w.manager, "POST", "/orders/checkout", {
      locationId: w.locationId,
      lines: [{ variantId: v.shoe, quantity: 1, unitPriceCents: 25000 }],
      tenders: [{ type: "CASH", amountCents: 27063 }],
      idempotencyKey: key(),
    });
    expect(low.status).toBe(201);

    const stmt = await w.as(w.manager, "GET", `/consignors/${consignor.body.id}/statement`);
    expect(stmt.body.owedCents).toBe(20000); // $250 - 20%

    const refund = await w.as(w.manager, "POST", `/orders/${low.body.order.id}/refund`, { lines: [{ orderLineId: low.body.order.lines[0].id, quantity: 1 }] });
    expect(refund.status).toBe(200);
    const after = await w.as(w.manager, "GET", `/consignors/${consignor.body.id}/statement`);
    expect(after.body.owedCents).toBe(0);
    expect(await onHand(v.shoe, w.locationId)).toBe(1);
    const ci = await prisma.consignmentItem.findUniqueOrThrow({ where: { id: item.body.id } });
    expect(ci).toMatchObject({ status: "ACTIVE", soldQty: 0 });
  });

  it("settles owed payouts (owner only)", async () => {
    const cust = await customer("Consignor Dee");
    const consignor = await w.as(w.manager, "POST", "/consignors", { customerId: cust, commissionBps: 1500 });
    await w.as(w.manager, "POST", "/consignment", { consignorId: consignor.body.id, variantId: v.shoe, locationId: w.locationId, quantity: 1 });
    await w.as(w.cashier, "POST", "/orders/checkout", {
      locationId: w.locationId,
      lines: [{ variantId: v.shoe, quantity: 1 }],
      tenders: [{ type: "CASH", amountCents: 32475 }],
      idempotencyKey: key(),
    });
    expect((await w.as(w.manager, "POST", `/consignors/${consignor.body.id}/settle`)).status).toBe(403);
    const settled = await w.as(w.owner, "POST", `/consignors/${consignor.body.id}/settle`);
    expect(settled.body.paidCents).toBe(25500);
    const log = await w.as(w.manager, "GET", "/audit?action=CONSIGNOR_SETTLED");
    expect(log.body[0]).toMatchObject({ staffName: "OWNER", details: { consignorId: consignor.body.id, paidCents: 25500 } });
  });
});

describe("events", () => {
  it("registers players through checkout and enforces capacity", async () => {
    const event = await w.as(w.manager, "POST", "/events", {
      locationId: w.locationId,
      name: "Friday Night Magic",
      game: "mtg",
      format: "Draft",
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      capacity: 1,
      entryFeeCents: 1500,
    });
    expect(event.status).toBe(201);
    const enter = (customerId: string) =>
      w.as(w.cashier, "POST", "/orders/checkout", {
        locationId: w.locationId,
        customerId,
        lines: [{ variantId: event.body.variantId, quantity: 1 }],
        tenders: [{ type: "CASH", amountCents: 1500 }],
        idempotencyKey: key(),
      });
    const a = await customer("Player A");
    const b = await customer("Player B");
    expect((await enter(a)).status).toBe(201);
    expect((await enter(a)).body.error).toBe("EVENT_FULL");
    const full = await enter(b);
    expect(full.status).toBe(409);

    const roster = await w.as(w.cashier, "GET", `/events/${event.body.id}`);
    expect(roster.body.spotsLeft).toBe(0);
    expect(roster.body.roster.map((r: any) => r.name)).toEqual(["Player A"]);
    const checkIn = await w.as(w.cashier, "POST", `/events/registrations/${roster.body.roster[0].registrationId}/check-in`);
    expect(checkIn.body.checkedIn).toBe(true);
  });
});

describe("preorders", () => {
  async function preorderProduct(allocation: number | null, perCustomerLimit: number | null = null) {
    const sealed = await w.as(w.manager, "POST", "/catalog/products", {
      kind: "TCG_SEALED",
      title: "Prismatic Evolutions Booster Bundle",
      game: "pokemon",
      variants: [{ sku: "PKM-PRE-BB", priceCents: 5000 }],
    });
    const variantId = sealed.body.variants[0].id;
    const pp = await w.as(w.manager, "POST", "/preorder-products", {
      variantId,
      releaseDate: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      allocation,
      depositCents: 1000,
      perCustomerLimit,
    });
    return { variantId, ppId: pp.body.id as string };
  }

  it("enforces allocation and per-customer limits", async () => {
    const { ppId } = await preorderProduct(3, 2);
    const a = await customer("A");
    const b = await customer("B");
    const place = (customerId: string, quantity: number) =>
      w.as(w.cashier, "POST", "/preorders", {
        preorderProductId: ppId,
        customerId,
        quantity,
        locationId: w.locationId,
        tenders: [{ type: "CARD", amountCents: 1000 * quantity, paymentToken: "tok_ok" }],
        idempotencyKey: key(),
      });
    expect((await place(a, 2)).status).toBe(201);
    expect((await place(a, 1)).body.error).toBe("CUSTOMER_LIMIT");
    expect((await place(b, 2)).body.error).toBe("ALLOCATION_EXHAUSTED");
    expect((await place(b, 1)).status).toBe(201);
    const avail = await w.as(w.cashier, "GET", `/preorder-products/${ppId}`);
    expect(avail.body.remaining).toBe(0);
  });

  it("cancels the reservation when the deposit is declined", async () => {
    const { ppId } = await preorderProduct(1);
    const res = await w.as(w.cashier, "POST", "/preorders", {
      preorderProductId: ppId,
      customerId: await customer(),
      quantity: 1,
      locationId: w.locationId,
      tenders: [{ type: "CARD", amountCents: 1000, paymentToken: "tok_decline" }],
      idempotencyKey: key(),
    });
    expect(res.status).toBe(402);
    expect((await w.as(w.cashier, "GET", `/preorder-products/${ppId}`)).body.remaining).toBe(1);
  });

  it("applies the deposit at pickup", async () => {
    const { ppId, variantId } = await preorderProduct(null);
    const cust = await customer();
    const pre = await w.as(w.cashier, "POST", "/preorders", {
      preorderProductId: ppId,
      customerId: cust,
      quantity: 1,
      locationId: w.locationId,
      tenders: [{ type: "CASH", amountCents: 1000 }],
      idempotencyKey: key(),
    });
    await w.as(w.manager, "POST", "/inventory/adjust", { variantId, locationId: w.locationId, delta: 10, reason: "RECEIVE" });
    // $50 + 8.25% = $54.13, minus $10 deposit = $44.13 due
    const pickup = await w.as(w.cashier, "POST", `/preorders/${pre.body.id}/fulfill`, {
      locationId: w.locationId,
      tenders: [{ type: "CARD", amountCents: 4413, paymentToken: "tok_ok" }],
      idempotencyKey: key(),
    });
    expect(pickup.status).toBe(200);
    expect(pickup.body.order.status).toBe("PAID");
    expect(pickup.body.order.payments.map((p: any) => p.tender).sort()).toEqual(["CARD", "PREORDER_DEPOSIT"]);
    expect(await onHand(variantId, w.locationId)).toBe(9);
    const again = await w.as(w.cashier, "POST", `/preorders/${pre.body.id}/fulfill`, {
      locationId: w.locationId,
      tenders: [{ type: "CARD", amountCents: 4413, paymentToken: "tok_ok" }],
      idempotencyKey: key(),
    });
    expect(again.status).toBe(409);
  });

  it("cancels to store credit", async () => {
    const { ppId } = await preorderProduct(5);
    const cust = await customer();
    const pre = await w.as(w.cashier, "POST", "/preorders", {
      preorderProductId: ppId,
      customerId: cust,
      quantity: 2,
      locationId: w.locationId,
      tenders: [{ type: "CARD", amountCents: 2000, paymentToken: "tok_ok" }],
      idempotencyKey: key(),
    });
    const cancel = await w.as(w.manager, "POST", `/preorders/${pre.body.id}/cancel`, { toStoreCredit: true });
    expect(cancel.body.status).toBe("CANCELLED");
    expect((await w.as(w.cashier, "GET", `/customers/${cust}`)).body.storeCreditCents).toBe(2000);
    expect((await w.as(w.cashier, "GET", `/preorder-products/${ppId}`)).body.remaining).toBe(5);
    const log = await w.as(w.manager, "GET", "/audit?action=PREORDER_CANCELLED");
    expect(log.body[0]).toMatchObject({
      staffName: "MANAGER",
      locationId: w.locationId,
      details: { preorderId: pre.body.id, customerId: cust, refundCents: 2000, toStoreCredit: true, tenders: [{ tender: "STORE_CREDIT", amountCents: 2000, status: "APPROVED" }] },
    });
  });

  it("taking store credit for a deposit follows the register's store-credit permission", async () => {
    const { ppId } = await preorderProduct(5);
    const cust = await customer();
    await w.as(w.manager, "POST", `/customers/${cust}/credit`, { amountCents: 5000, reason: "Trade-in" });
    const body = () => ({ preorderProductId: ppId, customerId: cust, quantity: 1, locationId: w.locationId, tenders: [{ type: "STORE_CREDIT", amountCents: 1000 }], idempotencyKey: key() });

    await w.as(w.owner, "PUT", "/roles/CASHIER", { permissions: { TENDER_STORE_CREDIT: "DENY" }, discountMaxBps: 1000 });
    expect((await w.as(w.cashier, "POST", "/preorders", body())).body).toMatchObject({ error: "PERMISSION_DENIED", details: { permission: "TENDER_STORE_CREDIT" } });
    expect((await w.as(w.cashier, "GET", `/customers/${cust}`)).body.storeCreditCents).toBe(5000);

    await w.as(w.owner, "PUT", "/roles/CASHIER", { permissions: { TENDER_STORE_CREDIT: "PIN" }, discountMaxBps: 1000 });
    expect((await w.as(w.cashier, "POST", "/preorders", body())).body.error).toBe("APPROVAL_REQUIRED");
    expect((await w.as(w.cashier, "GET", `/preorder-products/${ppId}`)).body.remaining).toBe(5);
    // Cash deposits aren't gated by it.
    expect((await w.as(w.cashier, "POST", "/preorders", { ...body(), tenders: [{ type: "CASH", amountCents: 1000 }] })).status).toBe(201);

    expect((await w.as(w.manager, "POST", "/preorders", body())).status).toBe(201);
    expect((await w.as(w.cashier, "GET", `/customers/${cust}`)).body.storeCreditCents).toBe(4000);
  });
});
