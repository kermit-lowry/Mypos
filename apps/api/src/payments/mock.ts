import type { GatewayResult, PaymentGateway, SaleRequest } from "./gateway.js";

/**
 * Deterministic gateway for dev and tests.
 * Token "tok_decline" declines; anything else approves.
 */
export class MockGateway implements PaymentGateway {
  readonly name = "mock";
  private seq = 0;
  readonly calls: { op: string; ref?: string; amountCents?: number }[] = [];

  async sale(req: SaleRequest): Promise<GatewayResult> {
    this.calls.push({ op: "sale", amountCents: req.amountCents });
    if (req.paymentToken === "tok_decline") return { approved: false, message: "Card declined" };
    const ref = `mock_${++this.seq}`;
    return { approved: true, gatewayRef: ref, cardBrand: "VISA", cardLast4: "4242" };
  }

  async refund(gatewayRef: string, amountCents: number): Promise<GatewayResult> {
    this.calls.push({ op: "refund", ref: gatewayRef, amountCents });
    return { approved: true, gatewayRef: `${gatewayRef}_r${++this.seq}` };
  }

  async void(gatewayRef: string): Promise<GatewayResult> {
    this.calls.push({ op: "void", ref: gatewayRef });
    return { approved: true, gatewayRef };
  }
}
