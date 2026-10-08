/**
 * Pluggable merchant gateway. Every processor adapter implements this so the
 * POS, storefront, and preorder flows never know which processor is behind them.
 */
export interface SaleRequest {
  amountCents: number;
  currency: string;
  /** Tokenized card from the gateway's hosted fields (card-not-present). */
  paymentToken?: string;
  /** Registered card-present device (card-present). */
  terminalId?: string;
  orderRef: string;
  idempotencyKey: string;
}

export interface GatewayResult {
  approved: boolean;
  gatewayRef?: string;
  cardBrand?: string;
  cardLast4?: string;
  message?: string;
  raw?: unknown;
}

export interface PaymentGateway {
  readonly name: string;
  sale(req: SaleRequest): Promise<GatewayResult>;
  /** `cardLast4` is required by some processors (Authorize.net) to issue a linked refund. */
  refund(gatewayRef: string, amountCents: number, cardLast4?: string): Promise<GatewayResult>;
  void(gatewayRef: string): Promise<GatewayResult>;
}
