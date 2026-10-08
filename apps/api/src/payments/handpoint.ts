import { randomUUID } from "node:crypto";
import type { FollowUpOptions, GatewayResult, PaymentGateway, SaleRequest, TerminalRef } from "./gateway.js";

/**
 * Handpoint Cloud REST API (v2.30) driving PAX smart terminals.
 * https://developer.handpoint.com/restapi/restendpoints
 *
 * POST /transactions returns 202 as soon as the request reaches the terminal;
 * the result arrives once the customer taps/inserts. We poll
 * /transaction-result/{id} (no public callback URL needed), and if that never
 * resolves, ask the status API by our transactionReference, which can tell us
 * definitively whether the card was charged.
 */
export interface HandpointOptions {
  apiKey: string;
  environment: "production" | "development";
  /** ISO 4217 code, e.g. "USD". */
  currency: string;
  pollIntervalMs?: number;
  /** How long to wait for the customer at the terminal before checking status. */
  timeoutMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface HandpointResult {
  finStatus?: string;
  transactionID?: string;
  transactionReference?: string;
  cardSchemeName?: string;
  maskedCardNumber?: string;
  statusMessage?: string;
  errorMessage?: string;
  totalAmount?: number;
  requestedAmount?: number;
  customerReceipt?: string;
  merchantReceipt?: string;
}

/** Handpoint says a transaction unknown to its gateway after 90s will not be charged. */
const NOT_CHARGED_AFTER_MS = 90_000;

export class HandpointGateway implements PaymentGateway {
  readonly name = "handpoint";
  private readonly base: string;
  private readonly statusBase: string;
  private readonly fetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;

  constructor(private readonly opts: HandpointOptions) {
    if (!opts.apiKey) throw new Error("HANDPOINT_API_KEY is required for card-present payments");
    const tld = opts.environment === "production" ? "com" : "io";
    this.base = `https://cloud.handpoint.${tld}`;
    this.statusBase = `https://transactions.handpoint.${tld}`;
    this.fetch = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
    this.pollIntervalMs = opts.pollIntervalMs ?? 2_000;
    this.timeoutMs = opts.timeoutMs ?? 180_000;
  }

  private headers() {
    return { ApiKeyCloud: this.opts.apiKey, "content-type": "application/json" };
  }

  async listTerminals(): Promise<TerminalRef[]> {
    const res = await this.fetch(`${this.base}/devices`, { headers: this.headers() });
    if (!res.ok) throw new Error(`Handpoint /devices ${res.status}: ${await res.text()}`);
    const devices = (await res.json()) as { serial_number: string; terminal_type: string }[];
    return devices.map((d) => ({ ref: d.serial_number, model: d.terminal_type }));
  }

  /** Send an operation to the terminal. Returns the result id, or a final result when the terminal refused it outright. */
  private async send(body: Record<string, unknown>): Promise<{ resultId: string } | { result: GatewayResult }> {
    let res: Response;
    try {
      res = await this.fetch(`${this.base}/transactions`, { method: "POST", headers: this.headers(), body: JSON.stringify(body) });
    } catch (e) {
      // The request may or may not have reached the terminal.
      return { result: { approved: false, pending: true, message: `Couldn't reach Handpoint: ${e instanceof Error ? e.message : e}` } };
    }
    const json = (await res.json().catch(() => ({}))) as {
      transactionResultId?: string;
      error?: { message?: { error?: number; message?: string } | string };
    };
    if (res.status === 202 && json.transactionResultId) return { resultId: json.transactionResultId };
    const err = typeof json.error?.message === "object" ? json.error.message : undefined;
    const message =
      err?.error === 1001
        ? "The terminal is busy with another transaction"
        : err?.error === 1002
          ? "The terminal is offline. Check it's on and connected"
          : (err?.message ?? (typeof json.error?.message === "string" ? json.error.message : `Handpoint error ${res.status}`));
    // 4xx means the terminal never started the operation: nothing was charged.
    return { result: { approved: false, pending: res.status >= 500, message, raw: json } };
  }

  private toResult(r: HandpointResult): GatewayResult {
    const status = r.finStatus ?? "UNDEFINED";
    const base = {
      gatewayRef: r.transactionID,
      cardBrand: r.cardSchemeName || undefined,
      cardLast4: r.maskedCardNumber ? r.maskedCardNumber.slice(-4) : undefined,
      raw: r,
    };
    if (status === "AUTHORISED") return { approved: true, ...base, message: r.statusMessage };
    if (status === "IN_PROGRESS" || status === "UNDEFINED") return { approved: false, pending: true, ...base, message: "Waiting on the terminal" };
    const reason = { DECLINED: "Card declined", CANCELLED: "Cancelled on the terminal", FAILED: "Card couldn't be read or the terminal failed" }[status];
    return { approved: false, ...base, message: r.errorMessage || reason || r.statusMessage || status };
  }

  /** Poll for the terminal's result until it arrives or `deadline` passes. */
  private async awaitResult(resultId: string, deadline: number): Promise<GatewayResult | null> {
    while (this.now() < deadline) {
      try {
        const res = await this.fetch(`${this.base}/transaction-result/${encodeURIComponent(resultId)}`, { headers: this.headers() });
        // 204 = still in progress; 404 = not stored yet. Both mean keep waiting.
        if (res.status === 200) return this.toResult((await res.json()) as HandpointResult);
      } catch {
        // Transient network error: keep polling until the deadline.
      }
      await this.sleep(this.pollIntervalMs);
    }
    return null;
  }

  /** Definitive status for an original operation, by the reference we generated. */
  async statusByReference(transactionReference: string, startedAt?: number): Promise<GatewayResult> {
    const res = await this.fetch(`${this.statusBase}/transactions/${encodeURIComponent(transactionReference)}/status`, {
      headers: this.headers(),
    });
    if (res.status === 404) {
      return this.notFound(transactionReference, startedAt);
    }
    if (!res.ok) return { approved: false, pending: true, gatewayRef: `ref:${transactionReference}`, message: `Status check failed (${res.status})` };
    const body = (await res.json()) as HandpointResult | HandpointResult[];
    const r = Array.isArray(body) ? body[0] : body;
    if (!r || r.finStatus === "UNDEFINED") return this.notFound(transactionReference, startedAt);
    const mapped = this.toResult(r);
    return mapped.pending ? { ...mapped, gatewayRef: `ref:${transactionReference}` } : mapped;
  }

  private notFound(transactionReference: string, startedAt?: number): GatewayResult {
    if (startedAt !== undefined && this.now() - startedAt >= NOT_CHARGED_AFTER_MS) {
      return { approved: false, message: "The sale never reached the card network; the customer wasn't charged" };
    }
    return { approved: false, pending: true, gatewayRef: `ref:${transactionReference}`, message: "Waiting on the terminal" };
  }

  async sale(req: SaleRequest): Promise<GatewayResult> {
    if (!req.terminal) return { approved: false, message: "Handpoint takes card-present payments only; pick a terminal" };
    const startedAt = this.now();
    // Unique per attempt (Handpoint's advice); lets us look the sale up later.
    const transactionReference = randomUUID();
    const sent = await this.send({
      operation: "sale",
      amount: String(req.amountCents),
      currency: this.opts.currency,
      terminal_type: req.terminal.model,
      serial_number: req.terminal.ref,
      customerReference: req.idempotencyKey.slice(0, 50),
      transactionReference,
    });
    if ("result" in sent) {
      return sent.result.pending ? { ...sent.result, gatewayRef: `ref:${transactionReference}` } : sent.result;
    }

    let result = await this.awaitResult(sent.resultId, startedAt + this.timeoutMs);
    if (!result || result.pending) result = await this.statusByReference(transactionReference, startedAt);

    const raw = result.raw as HandpointResult | undefined;
    if (raw?.finStatus === "PARTIAL_APPROVAL" && result.gatewayRef) {
      // US-only: the card covered part of the amount. Release that hold and let
      // the cashier split the payment instead.
      const voided = await this.void(result.gatewayRef, { terminal: req.terminal, amountCents: raw.totalAmount ?? req.amountCents });
      if (!voided.approved) {
        return { ...result, approved: false, pending: true, message: "Card was partially approved and the release failed; void it on the terminal" };
      }
      return { approved: false, message: "Card was only partially approved, so the hold was released. Split the payment or use another card" };
    }
    return result;
  }

  async refund(gatewayRef: string, amountCents: number, opts: FollowUpOptions = {}): Promise<GatewayResult> {
    if (!opts.terminal) return { approved: false, message: "Pick the terminal to run the refund on" };
    // Linked refund: no transactionReference, it's logged under the original sale's.
    return this.followUp(
      { operation: "refund", amount: String(amountCents), originalTransactionId: gatewayRef },
      opts.terminal,
    );
  }

  async void(gatewayRef: string, opts: FollowUpOptions = {}): Promise<GatewayResult> {
    if (!opts.terminal) return { approved: false, pending: true, message: "No terminal to run the void on" };
    if (opts.amountCents === undefined) return { approved: false, pending: true, message: "Void needs the original amount" };
    return this.followUp(
      { operation: "saleReversal", amount: String(opts.amountCents), originalTransactionId: gatewayRef },
      opts.terminal,
    );
  }

  async lookup(gatewayRef: string): Promise<GatewayResult> {
    if (gatewayRef.startsWith("ref:")) return this.statusByReference(gatewayRef.slice(4));
    // Already have the Handpoint transaction id: it reached a final state when we recorded it.
    return { approved: false, pending: true, gatewayRef, message: "Look this transaction up in the Handpoint portal" };
  }

  private async followUp(body: Record<string, unknown>, terminal: TerminalRef): Promise<GatewayResult> {
    const sent = await this.send({ ...body, currency: this.opts.currency, terminal_type: terminal.model, serial_number: terminal.ref });
    if ("result" in sent) return sent.result;
    return (await this.awaitResult(sent.resultId, this.now() + this.timeoutMs)) ?? {
      approved: false,
      pending: true,
      message: "The terminal didn't report back; check it before retrying",
    };
  }
}
