import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import { parse } from "../http.js";
import type { Ctx } from "../services/context.js";

export function staffRoutes(app: FastifyInstance, base: Ctx) {
  app.post("/auth/login", async (req) => {
    const { email, pin } = parse(z.object({ email: z.string().email(), pin: z.string().min(4) }), req.body);
    const staff = await base.prisma.staff.findUnique({ where: { email } });
    if (!staff || !staff.active || !(await bcrypt.compare(pin, staff.pinHash))) {
      throw new AppError(401, "BAD_LOGIN", "Wrong email or PIN");
    }
    const token = app.jwt.sign({ sub: staff.id, role: staff.role }, { expiresIn: "12h" });
    return { token, staff: { id: staff.id, name: staff.name, role: staff.role } };
  });
}
