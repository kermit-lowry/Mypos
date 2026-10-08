import type { StaffRole } from "@prisma/client";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ZodType, ZodTypeDef } from "zod";
import { AppError, badRequest, forbidden } from "./errors.js";
import { hasRole, type Actor } from "./services/context.js";

export function parse<T>(schema: ZodType<T, ZodTypeDef, unknown>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) throw badRequest("VALIDATION", "Invalid request", r.error.flatten());
  return r.data;
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string; role: StaffRole };
    user: { sub: string; role: StaffRole };
  }
}

/** preHandler: require a signed-in staff member with at least `min` role. */
export function requireRole(min: StaffRole) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      throw new AppError(401, "UNAUTHENTICATED", "Sign in at the register first");
    }
    if (!hasRole(actorOf(req), min)) throw forbidden();
  };
}

export function actorOf(req: FastifyRequest): Actor | undefined {
  const u = req.user as { sub: string; role: StaffRole } | undefined;
  return u ? { id: u.sub, role: u.role } : undefined;
}
