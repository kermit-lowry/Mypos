import type { FastifyInstance } from "fastify";
import type { Ctx } from "../services/context.js";

/** Online orders: the pickup/shipping queue the register watches, set-aside, ready, shipped and picked-up steps, pick tickets. */
export function fulfillmentRoutes(_app: FastifyInstance, _base: Ctx) {}
