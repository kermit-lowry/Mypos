import { describe, expect, it } from "vitest";
import { HandpointGateway } from "../src/payments/handpoint.js";

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

/** Scripted stand-in for Handpoint's cloud, using response shapes from their docs. */
function fakeHandpoint(handlers: { match: RegExp; method?: string; respond: Handler }[]) {
  const calls: { url: string; method: string; body: any; headers: any }[] = [];
  let clock = 0;
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : undefined, headers: init.headers });
    const h = handlers.find((h) => h.match.test(url) && (!h.method || h.method === method));
    if (!h) throw new Error(`Unexpected ${method} ${url}`);
    return h.respond(url, init);
  }) as typeof fetch;
  const gw = new HandpointGateway({
    apiKey: "test-key",
    environment: "development",
    currency: "USD",
    pollIntervalMs: 1_000,
    timeoutMs: 10_000,
    fetch: fetchImpl,
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
  });
  return { gw, calls, advance: (ms: number) => (clock += ms) };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const accepted = json(202, { transactionResultId: "1850025030-1", statusMessage: "Operation Accepted", transactionReference: "x" });
const terminal = { ref: "1850025030", model: "PAXA920PRO" };
const authorised = {
  finStatus: "AUTHORISED",
  transactionID: "1abe8dc0-389e-11f1-8672-a1e0852a3198",
  cardSchemeName: "Visa",
  maskedCardNumber: "************0936",
  totalAmount: 1083,
  statusMessage: "Approved",
};

describe("HandpointGateway", () => {
  it("lists PAX terminals", async () => {
    const { gw, calls } = fakeHandpoint([
      { match: /\/devices$/, respond: () => json(200, [{ merchant_id_alpha: "m", serial_number: "1850025030", ssk: "x", terminal_type: "PAXA920PRO" }]) },
    ]);
    expect(await gw.listTerminals()).toEqual([terminal]);
    expect(calls[0]!.url).toBe("https://cloud.handpoint.io/devices");
    expect(calls[0]!.headers.ApiKeyCloud).toBe("test-key");
  });

  it("runs a sale on the terminal and waits for the customer", async () => {
    let polls = 0;
    const { gw, calls } = fakeHandpoint([
      { match: /\/transactions$/, method: "POST", respond: () => accepted.clone() },
      // Two polls while the customer is tapping, then the result.
      { match: /\/transaction-result\//, respond: () => (++polls < 3 ? new Response(null, { status: 204 }) : json(200, authorised)) },
    ]);
    const r = await gw.sale({ amountCents: 1083, currency: "USD", terminal, orderRef: "1", idempotencyKey: "key-123:0" });
    expect(r).toMatchObject({ approved: true, gatewayRef: authorised.transactionID, cardBrand: "Visa", cardLast4: "0936" });
    const body = calls[0]!.body;
    expect(body).toMatchObject({ operation: "sale", amount: "1083", currency: "USD", terminal_type: "PAXA920PRO", serial_number: "1850025030" });
    expect(body.transactionReference).toMatch(/^[0-9a-f-]{36}$/);
    expect(polls).toBe(3);
  });

  it("reports declines and cancels as not charged", async () => {
    for (const finStatus of ["DECLINED", "CANCELLED", "FAILED"]) {
      const { gw } = fakeHandpoint([
        { match: /\/transactions$/, respond: () => accepted.clone() },
        { match: /\/transaction-result\//, respond: () => json(200, { finStatus, transactionID: "t1" }) },
      ]);
      const r = await gw.sale({ amountCents: 500, currency: "USD", terminal, orderRef: "1", idempotencyKey: "k" });
      expect(r.approved).toBe(false);
      expect(r.pending).toBeFalsy();
    }
  });

  it("treats a busy or offline terminal as not charged", async () => {
    for (const [code, text] of [[1001, /busy/], [1002, /offline/]] as const) {
      const { gw } = fakeHandpoint([
        { match: /\/transactions$/, respond: () => json(400, { error: { statusCode: 400, name: "BadRequestError", message: { error: code, message: "x" } } }) },
      ]);
      const r = await gw.sale({ amountCents: 500, currency: "USD", terminal, orderRef: "1", idempotencyKey: "k" });
      expect(r.approved).toBe(false);
      expect(r.pending).toBeFalsy();
      expect(r.message).toMatch(text);
    }
  });

  it("falls back to the status API when the result never arrives", async () => {
    const { gw, calls } = fakeHandpoint([
      { match: /\/transactions$/, method: "POST", respond: () => accepted.clone() },
      { match: /\/transaction-result\//, respond: () => new Response(null, { status: 204 }) },
      { match: /transactions\.handpoint\.io\/transactions\/.+\/status$/, respond: () => json(200, authorised) },
    ]);
    const r = await gw.sale({ amountCents: 1083, currency: "USD", terminal, orderRef: "1", idempotencyKey: "k" });
    expect(r).toMatchObject({ approved: true, gatewayRef: authorised.transactionID });
    const ref = calls[0]!.body.transactionReference;
    expect(calls.at(-1)!.url).toBe(`https://transactions.handpoint.io/transactions/${ref}/status`);
  });

  it("reports unknown when the gateway has never seen the sale yet (under 90s)", async () => {
    const { gw } = fakeHandpoint([
      { match: /\/transactions$/, method: "POST", respond: () => accepted.clone() },
      { match: /\/transaction-result\//, respond: () => new Response(null, { status: 204 }) },
      { match: /\/status$/, respond: () => json(404, {}) },
    ]);
    const r = await gw.sale({ amountCents: 1083, currency: "USD", terminal, orderRef: "1", idempotencyKey: "k" });
    expect(r.pending).toBe(true);
    expect(r.gatewayRef).toMatch(/^ref:/);
  });

  it("can later confirm the sale was never charged (after 90s)", async () => {
    const { gw, advance } = fakeHandpoint([{ match: /\/status$/, respond: () => json(404, {}) }]);
    const started = 0;
    advance(95_000);
    const r = await gw.statusByReference("abc", started);
    expect(r).toMatchObject({ approved: false });
    expect(r.pending).toBeFalsy();
  });

  it("treats a network failure on send as unknown, not declined", async () => {
    const { gw } = fakeHandpoint([{ match: /\/transactions$/, respond: () => Promise.reject(new Error("ECONNRESET")) }]);
    const r = await gw.sale({ amountCents: 500, currency: "USD", terminal, orderRef: "1", idempotencyKey: "k" });
    expect(r.pending).toBe(true);
  });

  it("releases a partial approval", async () => {
    const { gw, calls } = fakeHandpoint([
      { match: /\/transactions$/, method: "POST", respond: () => accepted.clone() },
      {
        match: /\/transaction-result\//,
        respond: () => {
          const voiding = calls.filter((c) => c.method === "POST").length > 1;
          return json(200, voiding ? { finStatus: "AUTHORISED", transactionID: "rev1" } : { finStatus: "PARTIAL_APPROVAL", transactionID: "t1", totalAmount: 600 });
        },
      },
    ]);
    const r = await gw.sale({ amountCents: 1000, currency: "USD", terminal, orderRef: "1", idempotencyKey: "k" });
    expect(r.approved).toBe(false);
    expect(r.message).toMatch(/partially approved/);
    expect(calls.find((c) => c.body?.operation === "saleReversal")?.body).toMatchObject({ amount: "600", originalTransactionId: "t1" });
  });

  it("sends linked refunds and voids without a transactionReference", async () => {
    const { gw, calls } = fakeHandpoint([
      { match: /\/transactions$/, method: "POST", respond: () => accepted.clone() },
      { match: /\/transaction-result\//, respond: () => json(200, { finStatus: "AUTHORISED", transactionID: "r1" }) },
    ]);
    expect((await gw.refund("t1", 500, { terminal })).approved).toBe(true);
    expect((await gw.void("t1", { terminal, amountCents: 1083 })).approved).toBe(true);
    const [refund, reversal] = calls.filter((c) => c.method === "POST").map((c) => c.body);
    expect(refund).toEqual({ operation: "refund", amount: "500", originalTransactionId: "t1", currency: "USD", terminal_type: "PAXA920PRO", serial_number: "1850025030" });
    expect(reversal).toMatchObject({ operation: "saleReversal", amount: "1083", originalTransactionId: "t1" });
    expect(reversal.transactionReference).toBeUndefined();
  });

  it("needs a terminal for refunds", async () => {
    const { gw } = fakeHandpoint([]);
    expect((await gw.refund("t1", 500)).approved).toBe(false);
  });
});
