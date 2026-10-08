import type { GatewayResult, PaymentGateway, SaleRequest } from "./gateway.js";

/**
 * Authorize.net JSON API. Card-not-present uses Accept.js opaque data; pass
 * the token as "<dataDescriptor>:<dataValue>".
 */
export class AuthorizeNetGateway implements PaymentGateway {
  readonly name = "authorizenet";
  private readonly endpoint: string;

  constructor(
    private readonly loginId: string,
    private readonly transactionKey: string,
    sandbox: boolean,
  ) {
    if (!loginId || !transactionKey) throw new Error("Authorize.net credentials are required");
    this.endpoint = sandbox ? "https://apitest.authorize.net/xml/v1/request.api" : "https://api.authorize.net/xml/v1/request.api";
  }

  private async request(transactionRequest: Record<string, unknown>): Promise<GatewayResult> {
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        createTransactionRequest: {
          merchantAuthentication: { name: this.loginId, transactionKey: this.transactionKey },
          transactionRequest,
        },
      }),
    });
    // Authorize.net prefixes JSON responses with a BOM.
    const json = JSON.parse((await res.text()).replace(/^﻿/, ""));
    const tr = json.transactionResponse ?? {};
    return {
      approved: tr.responseCode === "1",
      gatewayRef: tr.transId && tr.transId !== "0" ? tr.transId : undefined,
      cardBrand: tr.accountType,
      cardLast4: typeof tr.accountNumber === "string" ? tr.accountNumber.slice(-4) : undefined,
      message: tr.errors?.[0]?.errorText ?? tr.messages?.[0]?.description ?? json.messages?.message?.[0]?.text,
      raw: json,
    };
  }

  async sale(req: SaleRequest): Promise<GatewayResult> {
    if (req.terminalId) return { approved: false, message: "Card-present terminals are not yet configured for Authorize.net" };
    const [dataDescriptor, dataValue] = (req.paymentToken ?? "").split(":");
    if (!dataDescriptor || !dataValue) return { approved: false, message: "Missing Accept.js opaque data" };
    return this.request({
      transactionType: "authCaptureTransaction",
      amount: (req.amountCents / 100).toFixed(2),
      payment: { opaqueData: { dataDescriptor, dataValue } },
      order: { invoiceNumber: req.orderRef.slice(0, 20) },
    });
  }

  async refund(gatewayRef: string, amountCents: number, cardLast4?: string): Promise<GatewayResult> {
    // Linked refunds need the card's last 4; expiration may be masked.
    if (!cardLast4) return { approved: false, message: "Authorize.net refunds require the card's last 4 digits" };
    return this.request({
      transactionType: "refundTransaction",
      amount: (amountCents / 100).toFixed(2),
      payment: { creditCard: { cardNumber: cardLast4, expirationDate: "XXXX" } },
      refTransId: gatewayRef,
    });
  }

  void(gatewayRef: string): Promise<GatewayResult> {
    return this.request({ transactionType: "voidTransaction", refTransId: gatewayRef });
  }
}
