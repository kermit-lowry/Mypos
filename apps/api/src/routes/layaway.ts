import { LayawayInput, LayawayPaymentInput } from "@mypos/shared";
import { LayawayStatus } from "@prisma/client";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { badRequest, conflict, notFound } from "../errors.js";
import { actorOf, approvalTokenOf, authorize, parse, requirePermission, requireStaff } from "../http.js";
import type { Ctx } from "../services/context.js";
import { layawayStatementHtml } from "../services/documents.js";
import { layawayStatementEscPos, layawayStatementText } from "../services/escpos.js";
import { sendToPrinter } from "../services/labels.js";
import * as layaway from "../services/layaway.js";
import { audit } from "../services/permissions.js";
import { toCsv } from "../services/reports.js";

/**
 * Layaway: open with a deposit, take payments, pick up (creates the sale),
 * cancel with a fee; statements and reports.
 *
 * A layaway (GET /layaways/:id, and `layaway` in every write's response):
 *   { id, number, status: "ACTIVE"|"COMPLETED"|"CANCELLED", locationId, customerId, staffId,
 *     subtotalCents, discountCents, taxCents, totalCents (cash-price totals locked at opening),
 *     cardPriceBps, cardAdjustmentCents, cardAdjustmentTaxCents, paidCents, appliedPromotions,
 *     dueAt, notes, createdAt, updatedAt, completedAt, orderId, cancelledAt, cancelledById,
 *     cancelFeeCents, refundedCents, cancelReason,
 *     balanceCents (= total − paid), cardBalanceCents (the balance at the card price), overdue,
 *     customer: { id, name, email, phone }, staff: { id, name }|null, cancelledBy: { id, name }|null,
 *     lines: [{ id, variantId, title, quantity, unitPriceCents, discountCents, promoDiscountCents, taxable, costCents,
 *               variant: { sku, imageUrl, product: { title, imageUrl } } }],
 *     payments: [{ ...Payment, appliedCents, staff: { id, name }|null }],
 *     cancelFeePreview: { feeCents, refundCents }|null (while ACTIVE) }
 * List rows (GET /layaways) are the same without lines/payments/cancelledBy/cancelFeePreview, plus `lineCount`.
 */
export function layawayRoutes(app: FastifyInstance, base: Ctx) {
  const { prisma } = base;
  const staff = { preHandler: requireStaff() };
  const create = { preHandler: requirePermission("LAYAWAY_CREATE") };
  const manage = { preHandler: requirePermission("LAYAWAY_MANAGE") };
  const ctx = (req: FastifyRequest): Ctx => ({ ...base, actor: actorOf(req), perms: req.perms, approvalToken: approvalTokenOf(req) });
  const id = (req: FastifyRequest) => (req.params as { id: string }).id;

  /**
   * Open: lock the cart's prices (deals included, no manual discounts), reserve
   * the stock and take the deposit. 201 { layaway, changeCents, replayed }.
   * 409 LAYAWAY_DISABLED, 400 DEPOSIT_TOO_SMALL { minimumCents }, 400 OVERPAID,
   * 409 INSUFFICIENT_STOCK (nothing charged), 402 PAYMENT_DECLINED, 409 DRAWER_CLOSED.
   * A retry with the same idempotencyKey returns the same layaway (200).
   */
  app.post("/layaways", create, async (req, reply) => {
    const input = parse(LayawayInput, req.body);
    // Same gate as paying for a sale with store credit.
    if (input.tenders.some((t) => t.type === "STORE_CREDIT")) await authorize(req, "TENDER_STORE_CREDIT", "layaway deposit");
    const result = await layaway.openLayaway(ctx(req), input);
    if (result.replayed && layaway.depositFailed(result.layaway)) {
      throw conflict("LAYAWAY_FAILED", "This layaway's deposit failed earlier; start a new one", { layawayId: result.layaway.id });
    }
    return reply.code(result.replayed ? 200 : 201).send(result);
  });

  /** A payment toward the balance. 201 { layaway, payments, changeCents, replayed }; 400 OVERPAID { balanceCents }. */
  app.post("/layaways/:id/payments", create, async (req, reply) => {
    const input = parse(LayawayPaymentInput, req.body);
    if (input.tenders.some((t) => t.type === "STORE_CREDIT")) await authorize(req, "TENDER_STORE_CREDIT", "layaway payment");
    const result = await layaway.takePayment(ctx(req), id(req), input);
    return reply.code(result.replayed ? 200 : 201).send(result);
  });

  /** Pick up: the balance must be zero (409 BALANCE_DUE { balanceCents }). 200 { layaway, order }. */
  app.post("/layaways/:id/complete", create, async (req) => layaway.completeLayaway(ctx(req), id(req)));

  /**
   * Cancel: stock back, refund minus the fee to the original tenders (cards
   * first) or to store credit. `waiveFee` needs LAYAWAY_MANAGE.
   * 200 { layaway, feeCents, refundedCents, legs: [{ tender, amountCents, status, message? }] }.
   */
  app.post("/layaways/:id/cancel", { preHandler: requirePermission("LAYAWAY_CANCEL") }, async (req) => {
    const input = parse(
      z.object({ toStoreCredit: z.boolean().default(false), waiveFee: z.boolean().default(false), reason: z.string().trim().max(500).optional(), terminalId: z.string().optional() }),
      req.body ?? {},
    );
    if (input.waiveFee) await authorize(req, "LAYAWAY_MANAGE", "waive layaway fee");
    const result = await layaway.cancelLayaway(ctx(req), id(req), input);
    await audit(prisma, {
      action: "LAYAWAY_CANCELLED",
      staffId: req.user.sub,
      approverId: req.approverId,
      locationId: result.layaway.locationId,
      details: {
        layawayId: result.layaway.id,
        number: result.layaway.number,
        feeCents: result.feeCents,
        refundedCents: result.refundedCents,
        legs: result.legs,
        toStoreCredit: input.toStoreCredit,
        waived: input.waiveFee,
        reason: input.reason ?? null,
      } as object,
    });
    return result;
  });

  // ── Manage ─────────────────────────────────────────────────
  app.post("/layaways/:id/extend", manage, async (req) => {
    const { dueAt } = parse(z.object({ dueAt: z.coerce.date() }), req.body);
    return layaway.extendLayaway(ctx(req), id(req), dueAt);
  });

  app.patch("/layaways/:id", manage, async (req) => {
    const data = parse(z.object({ notes: z.string().max(1000).nullable().optional() }), req.body);
    return layaway.updateLayaway(ctx(req), id(req), data);
  });

  // ── Read ───────────────────────────────────────────────────
  app.get("/layaways", staff, async (req) => {
    const q = parse(
      z.object({
        locationId: z.string().optional(),
        customerId: z.string().optional(),
        status: z.nativeEnum(LayawayStatus).optional(),
        overdue: z.enum(["true", "false"]).optional(),
        q: z.string().trim().optional(),
        take: z.coerce.number().int().positive().max(500).default(50),
      }),
      req.query,
    );
    return layaway.listLayaways(prisma, { ...q, overdue: q.overdue === "true" });
  });

  app.get("/layaways/:id", staff, async (req) => layaway.getLayaway(prisma, id(req)));

  /** The customer's statement: items, totals, payments so far, balance and due date. JSON, thermal text (`width` columns) or printable HTML. */
  app.get("/layaways/:id/receipt", staff, async (req, reply) => {
    const q = parse(z.object({ format: z.enum(["json", "text", "html"]).default("json"), width: z.coerce.number().int().min(24).max(64).default(42) }), req.query);
    const s = await layaway.buildLayawayStatement(prisma, id(req));
    if (q.format === "text") return reply.type("text/plain; charset=utf-8").send(layawayStatementText(s, q.width));
    if (q.format === "html") return reply.type("text/html; charset=utf-8").send(layawayStatementHtml(s));
    return s;
  });

  /** Print the statement on a register's ESC/POS receipt printer. */
  app.post("/layaways/:id/receipt/print", staff, async (req) => {
    const body = parse(z.object({ terminalId: z.string(), width: z.coerce.number().int().min(24).max(64).default(42) }), req.body);
    const l = await prisma.layaway.findUnique({ where: { id: id(req) }, select: { locationId: true } });
    if (!l) throw notFound("Layaway");
    const terminal = await prisma.terminal.findUnique({ where: { id: body.terminalId } });
    if (!terminal) throw notFound("Terminal");
    if (terminal.locationId !== l.locationId) throw badRequest("TERMINAL", "That register isn't at this layaway's location");
    if (!terminal.receiptPrinterHost) throw badRequest("NO_PRINTER", "No receipt printer set up for this register");
    await sendToPrinter(terminal.receiptPrinterHost, layawayStatementEscPos(await layaway.buildLayawayStatement(prisma, id(req)), body.width));
    return { printed: true, on: "printer" };
  });

  // ── Report ─────────────────────────────────────────────────
  /** Active layaways: { active, overdue, balanceCents (still owed), heldCents (collected and held), rows }. `format=csv` downloads the rows. */
  app.get("/reports/layaways", { preHandler: requirePermission("VIEW_REPORTS") }, async (req, reply) => {
    const q = parse(z.object({ locationId: z.string().optional(), format: z.enum(["json", "csv"]).default("json") }), req.query);
    const report = await layaway.layawayReport(prisma, q.locationId);
    if (q.format === "csv") {
      const rows = report.rows.map((r) => ({ ...r, openedAt: r.openedAt.toISOString(), dueAt: r.dueAt.toISOString() }));
      return reply.type("text/csv; charset=utf-8").header("content-disposition", `attachment; filename="layaways.csv"`).send(toCsv(rows));
    }
    return report;
  });
}
