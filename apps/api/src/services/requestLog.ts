import type { Prisma, PrismaClient } from "@prisma/client";
import type { FastifyInstance, FastifyRequest } from "fastify";

/**
 * Log every write to the API: register and back office alike. Read-only
 * POSTs (price previews) and the customer display's constant refreshes are
 * skipped so the log stays useful.
 */
const SKIP = new Set(["PUT /displays/:channel", "POST /cart/quote", "POST /loyalty/quote", "POST /storefront/quote"]);

/** Sign-in and approval bodies are credentials through and through: never logged, whatever the fields are called. */
const NO_BODY = new Set(["POST /auth/login", "POST /auth/web-login", "POST /auth/password", "POST /auth/approve"]);

// Whole-word where a bare key is the secret (`pin`, `code`, `current`), so
// `shippingCents`, `barcode`, and `currentStock` stay readable.
const SECRET_KEYS = /^current$|^code$|^otp$|^pin$|pinhash|pinlookup|token|password|secret|giftcardcode|cardnumber|cvv/i;
const MAX_BYTES = 8_000;

/** Copy of a request body with secrets replaced and long values cut. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[…]";
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEYS.test(k) ? "[redacted]" : redact(v, depth + 1)]));
  }
  if (typeof value === "string" && value.length > 500) return `${value.slice(0, 500)}…`;
  return value;
}

export function registerRequestLog(app: FastifyInstance, prisma: PrismaClient) {
  app.addHook("onResponse", async (req: FastifyRequest, reply) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return;
    const route = `${req.method} ${req.routeOptions.url ?? req.url.split("?")[0]}`;
    if (SKIP.has(route)) return;
    const params = redact(req.params) as Prisma.InputJsonValue;
    const body = NO_BODY.has(route) ? "[credentials omitted]" : (redact(req.body) as Prisma.InputJsonValue);
    let details: Prisma.InputJsonValue = { route, params, body };
    if (JSON.stringify(details).length > MAX_BYTES) details = { route, params, body: "[too large to log]" };
    const user = req.user as { sub?: string } | undefined;
    try {
      await prisma.auditEvent.create({
        data: {
          action: "REQUEST",
          staffId: user?.sub ?? null,
          approverId: req.approverId ?? null,
          status: reply.statusCode,
          ip: req.ip,
          details,
        },
      });
    } catch (e) {
      // Never fail a sale because logging failed; surface it in the server log instead.
      req.log.error({ err: e, route }, "audit log write failed");
    }
  });
}
