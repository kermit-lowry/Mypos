import type { FollowUpOptions, GatewayResult, PaymentGateway, SaleRequest, TerminalRef } from "./gateway.js";

/**
 * Routes card-present sales (a terminal was picked) to the terminal processor
 * and card-not-present sales to the online gateway. Refunds and voids go back
 * to whichever processor took the original payment.
 */
export class RoutingGateway implements PaymentGateway {
  readonly name = "router";

  constructor(
    private readonly cardPresent: PaymentGateway | undefined,
    private readonly cardNotPresent: PaymentGateway | undefined,
  ) {}

  private pick(opts: FollowUpOptions = {}): PaymentGateway | undefined {
    const all = [this.cardPresent, this.cardNotPresent];
    return all.find((g) => g && g.name === opts.gateway) ?? (opts.terminal ? this.cardPresent : this.cardNotPresent);
  }

  async sale(req: SaleRequest): Promise<GatewayResult> {
    const g = req.terminal ? this.cardPresent : this.cardNotPresent;
    if (!g) return { approved: false, message: req.terminal ? "No card terminal processor is configured" : "No online card processor is configured" };
    return { ...(await g.sale(req)), gateway: g.name };
  }

  async refund(gatewayRef: string, amountCents: number, opts?: FollowUpOptions): Promise<GatewayResult> {
    const g = this.pick(opts);
    if (!g) return { approved: false, message: "No processor for this payment" };
    return { ...(await g.refund(gatewayRef, amountCents, opts)), gateway: g.name };
  }

  async void(gatewayRef: string, opts?: FollowUpOptions): Promise<GatewayResult> {
    const g = this.pick(opts);
    if (!g) return { approved: false, pending: true, message: "No processor for this payment" };
    return { ...(await g.void(gatewayRef, opts)), gateway: g.name };
  }

  async lookup(gatewayRef: string, opts?: FollowUpOptions): Promise<GatewayResult> {
    const g = this.pick(opts);
    if (!g?.lookup) return { approved: false, pending: true, gatewayRef, message: "This processor can't look payments up" };
    return { ...(await g.lookup(gatewayRef, opts)), gateway: g.name };
  }

  async printReceipt(html: string, terminal: TerminalRef): Promise<GatewayResult> {
    if (!this.cardPresent?.printReceipt) return { approved: false, message: "This terminal can't print receipts" };
    return this.cardPresent.printReceipt(html, terminal);
  }

  async listTerminals(): Promise<TerminalRef[]> {
    const g = this.cardPresent as (PaymentGateway & { listTerminals?: () => Promise<TerminalRef[]> }) | undefined;
    if (!g?.listTerminals) throw new Error("No card terminal processor is configured");
    return g.listTerminals();
  }
}
