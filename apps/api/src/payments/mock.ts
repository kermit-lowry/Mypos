import type { FollowUpOptions, GatewayResult, PaymentGateway, SaleRequest } from "./gateway.js";

/**
 * Deterministic gateway for dev and tests.
 * Token "tok_decline" declines; anything else approves.
 */
export class MockGateway implements PaymentGateway {
  readonly name = "mock";
  private seq = 0;
  readonly calls: { op: string; ref?: string; amountCents?: number; terminal?: string }[] = [];

  /** Next sale returns this instead (tests script terminal outcomes). */
  nextSale: GatewayResult | null = null;
  lastSale: SaleRequest | null = null;

  async sale(req: SaleRequest): Promise<GatewayResult> {
    this.calls.push({ op: "sale", amountCents: req.amountCents });
    this.lastSale = req;
    if (this.nextSale) {
      const r = this.nextSale;
      this.nextSale = null;
      return r;
    }
    if (req.paymentToken === "tok_decline") return { approved: false, message: "Card declined" };
    if (req.paymentToken === "tok_pending") return { approved: false, pending: true, gatewayRef: `mock_${++this.seq}`, message: "Terminal stopped responding" };
    const ref = `mock_${++this.seq}`;
    return { approved: true, gatewayRef: ref, cardBrand: "VISA", cardLast4: "4242" };
  }

  /** Outcome a later lookup() reports for pending payments. */
  lookupResult: GatewayResult = { approved: true };

  async refund(gatewayRef: string, amountCents: number, opts: FollowUpOptions = {}): Promise<GatewayResult> {
    this.calls.push({ op: "refund", ref: gatewayRef, amountCents, terminal: opts.terminal?.ref });
    return { approved: true, gatewayRef: `${gatewayRef}_r${++this.seq}` };
  }

  async void(gatewayRef: string, opts: FollowUpOptions = {}): Promise<GatewayResult> {
    this.calls.push({ op: "void", ref: gatewayRef, amountCents: opts.amountCents, terminal: opts.terminal?.ref });
    return { approved: true, gatewayRef };
  }

  readonly printed: { html: string; terminal: string }[] = [];

  async printReceipt(html: string, terminal: { ref: string }): Promise<GatewayResult> {
    this.printed.push({ html, terminal: terminal.ref });
    return { approved: true };
  }

  async lookup(gatewayRef: string): Promise<GatewayResult> {
    this.calls.push({ op: "lookup", ref: gatewayRef });
    return { gatewayRef, ...this.lookupResult };
  }
}
