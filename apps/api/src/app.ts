import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import type { PrismaClient } from "@prisma/client";
import Fastify from "fastify";
import { config } from "./config.js";
import { AppError } from "./errors.js";
import type { PaymentGateway } from "./payments/gateway.js";
import { adminRoutes } from "./routes/admin.js";
import { catalogRoutes } from "./routes/catalog.js";
import { loyaltyRoutes } from "./routes/loyalty.js";
import { salesRoutes } from "./routes/sales.js";
import { staffRoutes } from "./routes/staff.js";
import { storefrontRoutes } from "./routes/storefront.js";
import { terminalRoutes } from "./routes/terminals.js";
import { tradeRoutes } from "./routes/trade.js";

export async function buildApp(deps: { prisma: PrismaClient; gateway: PaymentGateway; logger?: boolean }) {
  const app = Fastify({ logger: deps.logger ?? false });
  await app.register(cors, { origin: true });
  await app.register(jwt, { secret: config.jwtSecret });

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

  const ctx = { prisma: deps.prisma, gateway: deps.gateway };
  app.get("/health", async () => ({ ok: true }));
  staffRoutes(app, ctx);
  catalogRoutes(app, ctx);
  salesRoutes(app, ctx);
  tradeRoutes(app, ctx);
  adminRoutes(app, ctx);
  loyaltyRoutes(app, ctx);
  terminalRoutes(app, ctx);
  storefrontRoutes(app, ctx, {
    // Web orders ship from the first location until per-location fulfillment is configured.
    fulfillmentLocationId: async () => (await deps.prisma.location.findFirstOrThrow({ orderBy: { createdAt: "asc" } })).id,
  });
  return app;
}
