import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { MockGateway } from "../src/payments/mock.js";

export const prisma = new PrismaClient();

export async function resetDb() {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
}

export interface World {
  app: FastifyInstance;
  gateway: MockGateway;
  locationId: string;
  cashier: string;
  manager: string;
  owner: string;
  /** Inject with a staff token. */
  as(token: string, method: "GET" | "POST" | "PUT" | "PATCH", url: string, body?: unknown): Promise<{ status: number; body: any }>;
}

export async function setup(): Promise<World> {
  await resetDb();
  const gateway = new MockGateway();
  const app = await buildApp({ prisma, gateway });
  const location = await prisma.location.create({ data: { name: "Main St", taxRateBps: 825 } });
  const pinHash = await bcrypt.hash("1234", 4);
  const tokens: Record<string, string> = {};
  for (const role of ["CASHIER", "MANAGER", "OWNER"] as const) {
    const email = `${role.toLowerCase()}@shop.test`;
    await prisma.staff.create({ data: { name: role, email, pinHash, role } });
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, pin: "1234" } });
    tokens[role] = res.json().token;
  }
  const as: World["as"] = async (token, method, url, body) => {
    const res = await app.inject({ method, url, payload: body as object, headers: { authorization: `Bearer ${token}` } });
    return { status: res.statusCode, body: res.body ? res.json() : undefined };
  };
  return { app, gateway, locationId: location.id, cashier: tokens.CASHIER!, manager: tokens.MANAGER!, owner: tokens.OWNER!, as };
}

let keySeq = 0;
export const key = () => `test-key-${Date.now()}-${++keySeq}`;

/** A Charizard single (NM + LP) and a sneaker, with stock. */
export async function seedCatalog(w: World) {
  const card = await w.as(w.manager, "POST", "/catalog/products", {
    kind: "TCG_SINGLE",
    title: "Charizard ex",
    game: "pokemon",
    setCode: "OBF",
    setName: "Obsidian Flames",
    collectorNumber: "125",
    channels: ["POS", "STOREFRONT"],
    variants: [
      { sku: "PKM-OBF-125-NM", priceCents: 1000, condition: "NM", finish: "HOLO" },
      { sku: "PKM-OBF-125-LP", priceCents: 850, condition: "LP", finish: "HOLO" },
    ],
  });
  const shoe = await w.as(w.manager, "POST", "/catalog/products", {
    kind: "SNEAKER",
    title: "Jordan 1 Retro High OG Chicago",
    brand: "Jordan",
    styleCode: "DZ5485-612",
    variants: [{ sku: "DZ5485-612-10", priceCents: 30000, size: "10", itemCondition: "DS", serialized: true }],
  });
  const [nm, lp] = card.body.variants;
  const [size10] = shoe.body.variants;
  for (const v of [nm, lp]) {
    await w.as(w.manager, "POST", "/inventory/adjust", { variantId: v.id, locationId: w.locationId, delta: 3, reason: "RECEIVE" });
  }
  return { nm: nm.id as string, lp: lp.id as string, shoe: size10.id as string };
}

export async function onHand(variantId: string, locationId: string) {
  const l = await prisma.inventoryLevel.findUnique({ where: { variantId_locationId: { variantId, locationId } } });
  return l?.onHand ?? 0;
}
