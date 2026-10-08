import type { GatewayResult, PaymentGateway, SaleRequest } from "./gateway.js";

/**
 * NMI Direct Post API (https://secure.nmi.com/api/transact.php).
 * Card-not-present uses a Collect.js `payment_token`. Many ISOs white-label NMI,
 * so this adapter also covers those gateways by changing `endpoint`.
 */
export class NmiGateway implements PaymentGateway {
  readonly name = "nmi";

  constructor(
    private readonly securityKey: string,
    private readonly endpoint = "https://secure.nmi.com/api/transact.php",
  ) {
    if (!securityKey) throw new Error("NMI_SECURITY_KEY is required for the NMI gateway");
  }

  private async post(fields: Record<string, string>): Promise<GatewayResult> {
    const body = new URLSearchParams({ security_key: this.securityKey, ...fields });
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const parsed = Object.fromEntries(new URLSearchParams(await res.text()));
    // response: 1 = approved, 2 = declined, 3 = error
    return {
      approved: parsed.response === "1",
      gatewayRef: parsed.transactionid || undefined,
      cardLast4: parsed.cc_number?.slice(-4),
      cardBrand: parsed.cc_type,
      message: parsed.responsetext,
      raw: parsed,
    };
  }

  async sale(req: SaleRequest): Promise<GatewayResult> {
    if (req.terminalId) {
      // Card-present on NMI goes through their Customer-Present Cloud device API,
      // which is asynchronous and device-specific. Wire it up for your terminal model here.
      return { approved: false, message: "Card-present terminals are not yet configured for NMI" };
    }
    if (!req.paymentToken) return { approved: false, message: "Missing payment token" };
    return this.post({
      type: "sale",
      amount: (req.amountCents / 100).toFixed(2),
      currency: req.currency,
      payment_token: req.paymentToken,
      orderid: req.orderRef,
    });
  }

  refund(gatewayRef: string, amountCents: number): Promise<GatewayResult> {
    return this.post({ type: "refund", transactionid: gatewayRef, amount: (amountCents / 100).toFixed(2) });
  }

  void(gatewayRef: string): Promise<GatewayResult> {
    return this.post({ type: "void", transactionid: gatewayRef });
  }
}
