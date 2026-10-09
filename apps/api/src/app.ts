import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import type { PrismaClient } from "@prisma/client";
import Fastify from "fastify";
import { config } from "./config.js";
import { AppError } from "./errors.js";
import type { PaymentGateway } from "./payments/gateway.js";
import { adminRoutes } from "./routes/admin.js";
import { defaultCardSources, type CardSource } from "./pricing/cardSources.js";
import { catalogRoutes } from "./routes/catalog.js";
import { dealRoutes } from "./routes/deals.js";
import { fulfillmentRoutes } from "./routes/fulfillment.js";
import { layawayRoutes } from "./routes/layaway.js";
import { loyaltyRoutes } from "./routes/loyalty.js";
import { pricingRoutes } from "./routes/pricing.js";
import { purchasingRoutes } from "./routes/purchasing.js";
import { reportRoutes } from "./routes/reports.js";
import { salesRoutes } from "./routes/sales.js";
import { shiftRoutes } from "./routes/shifts.js";
import { timeClockRoutes } from "./routes/timeclock.js";
import { staffRoutes } from "./routes/staff.js";
import { taskRoutes } from "./routes/tasks.js";
import { userRoutes } from "./routes/users.js";
import { storefrontRoutes } from "./routes/storefront.js";
import { terminalRoutes } from "./routes/terminals.js";
import { registerRequestLog } from "./services/requestLog.js";
import { tradeRoutes } from "./routes/trade.js";

export async function buildApp(deps: { prisma: PrismaClient; gateway: PaymentGateway; logger?: boolean; cardSources?: CardSource[] }) {
  const app = Fastify({ logger: deps.logger ?? false });
  // Browsers (web store, web preview/back office) need the write methods
  // allowed explicitly; @fastify/cors only allows GET, HEAD, and POST by default.
  await app.register(cors, { origin: true, methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] });
  await app.register(jwt, { secret: config.jwtSecret });

  // Treat an empty JSON body as "no body" instead of a 400, so a client that
  // always sends the JSON content type can still call body-less actions.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const text = typeof body === "string" ? body : body.toString("utf8");
    if (text.trim() === "") return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch (e) {
      done(Object.assign(e as Error, { statusCode: 400 }), undefined);
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.status).send({ error: err.code, message: err.message, details: err.details });
    }
    const e = err as { code?: string; statusCode?: number; message?: string };
    if (e.code === "P2025") return reply.code(404).send({ error: "NOT_FOUND", message: "Record not found" });
    if (e.code === "P2002") return reply.code(409).send({ error: "DUPLICATE", message: "Already exists" });
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: "BAD_REQUEST", message: e.message });
    app.log.error(err);
    return reply.code(500).send({ error: "INTERNAL", message: "Something went wrong" });
  });

  registerRequestLog(app, deps.prisma);

  const ctx = { prisma: deps.prisma, gateway: deps.gateway };
  app.get("/health", async () => ({ ok: true }));
  staffRoutes(app, ctx);
  userRoutes(app, ctx);
  catalogRoutes(app, ctx);
  salesRoutes(app, ctx);
  tradeRoutes(app, ctx, deps.cardSources ?? defaultCardSources());
  adminRoutes(app, ctx);
  loyaltyRoutes(app, ctx);
  terminalRoutes(app, ctx);
  pricingRoutes(app, ctx);
  shiftRoutes(app, ctx);
  timeClockRoutes(app, ctx);
  layawayRoutes(app, ctx);
  taskRoutes(app, ctx);
  fulfillmentRoutes(app, ctx);
  dealRoutes(app, ctx);
  purchasingRoutes(app, ctx);
  reportRoutes(app, ctx);
  storefrontRoutes(app, ctx, {
    // Web orders ship from the first location until per-location fulfillment is configured.
    fulfillmentLocationId: async () => (await deps.prisma.location.findFirstOrThrow({ orderBy: { createdAt: "asc" } })).id,
  });
  return app;
}
