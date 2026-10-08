/**
 * Pluggable merchant gateway. Every processor adapter implements this so the
 * POS, storefront, and preorder flows never know which processor is behind them.
 */
export interface TerminalRef {
  /** Device id on the processor (Handpoint: serial_number). */
  ref: string;
  /** Device model (Handpoint: terminal_type, e.g. "PAXA920PRO"). */
  model: string | null;
}

export interface SaleRequest {
  amountCents: number;
  currency: string;
  /** Tokenized card from the gateway's hosted fields (card-not-present). */
  paymentToken?: string;
  /** Card-present device to run the sale on. */
  terminal?: TerminalRef;
  orderRef: string;
  idempotencyKey: string;
}

export interface GatewayResult {
  approved: boolean;
  /**
   * The outcome is unknown: the customer may or may not have been charged
   * (e.g. the terminal stopped responding mid-sale). Never treat as a decline.
   */
  pending?: boolean;
  /** Which processor handled it, when a router picked one. */
  gateway?: string;
  gatewayRef?: string;
  cardBrand?: string;
  cardLast4?: string;
  message?: string;
  raw?: unknown;
}

export interface FollowUpOptions {
  /** Original amount; some processors need it to void. */
  amountCents?: number;
  /** Required by some processors (Authorize.net) to issue a linked refund. */
  cardLast4?: string;
  /** Card-present processors run refunds/voids on a terminal. */
  terminal?: TerminalRef;
  /** Processor that took the original payment (Payment.gateway). */
  gateway?: string;
}

export interface PaymentGateway {
  readonly name: string;
  sale(req: SaleRequest): Promise<GatewayResult>;
  refund(gatewayRef: string, amountCents: number, opts?: FollowUpOptions): Promise<GatewayResult>;
  void(gatewayRef: string, opts?: FollowUpOptions): Promise<GatewayResult>;
  /** Re-check a pending payment's outcome, where the processor supports it. */
  lookup?(gatewayRef: string, opts?: FollowUpOptions): Promise<GatewayResult>;
}
