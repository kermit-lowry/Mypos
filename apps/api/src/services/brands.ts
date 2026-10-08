import type { PrismaClient } from "@prisma/client";
import type { Db } from "../db.js";
import { conflict, notFound } from "../errors.js";

/**
 * Brands are matched by name, case-insensitively, so "nike", "Nike " and
 * "NIKE" are one brand. Products keep the brand's display name in
 * `Product.brand` for search and reports.
 */
export async function brandFor(db: Db, name: string | null | undefined): Promise<{ id: string; name: string } | null> {
  const clean = name?.trim();
  if (!clean) return null;
  const existing = await db.brand.findFirst({ where: { name: { equals: clean, mode: "insensitive" } } });
  if (existing) return existing;
  return db.brand.create({ data: { name: clean } });
}

/** Product data for a brand given by name or id. `null` clears it. */
export async function brandData(db: Db, input: { brand?: string | null; brandId?: string | null }): Promise<{ brand: string | null; brandId: string | null } | {}> {
  if (input.brandId !== undefined) {
    if (input.brandId === null) return { brand: null, brandId: null };
    const b = await db.brand.findUnique({ where: { id: input.brandId } });
    if (!b) throw notFound("Brand");
    return { brand: b.name, brandId: b.id };
  }
  if (input.brand !== undefined) {
    const b = await brandFor(db, input.brand);
    return { brand: b?.name ?? null, brandId: b?.id ?? null };
  }
  return {};
}

export async function renameBrand(db: PrismaClient, id: string, name: string) {
  const clean = name.trim();
  const clash = await db.brand.findFirst({ where: { name: { equals: clean, mode: "insensitive" }, id: { not: id } } });
  if (clash) throw conflict("BRAND_EXISTS", `There's already a brand called ${clash.name}; merge into it instead`);
  return db.$transaction(async (tx) => {
    const b = await tx.brand.update({ where: { id }, data: { name: clean } });
    await tx.product.updateMany({ where: { brandId: id }, data: { brand: clean } });
    return b;
  });
}

/** Move every product from one brand onto another and drop the first. */
export async function mergeBrands(db: PrismaClient, fromId: string, intoId: string) {
  if (fromId === intoId) throw conflict("BRAND_SAME", "Pick two different brands");
  const into = await db.brand.findUnique({ where: { id: intoId } });
  if (!into) throw notFound("Brand");
  return db.$transaction(async (tx) => {
    const moved = await tx.product.updateMany({ where: { brandId: fromId }, data: { brandId: into.id, brand: into.name } });
    await tx.brand.delete({ where: { id: fromId } });
    return { into, moved: moved.count };
  });
}
