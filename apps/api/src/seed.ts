/** Demo data: one store, three staff (PIN 1234), and a few TCG + sneaker products. */
import bcrypt from "bcryptjs";
import { prisma } from "./db.js";
import { seedCategoriesAndDeals } from "./seedDeals.js";

const pinHash = await bcrypt.hash("1234", 10);
const location = await prisma.location.create({ data: { name: "Main Street", taxRateBps: 825 } });
for (const [name, role] of [["Owner", "OWNER"], ["Manager", "MANAGER"], ["Cashier", "CASHIER"]] as const) {
  await prisma.staff.create({ data: { name, email: `${role.toLowerCase()}@mypos.local`, pinHash, role } });
}

const products = [
  {
    kind: "TCG_SINGLE" as const,
    title: "Sheoldred, the Apocalypse",
    game: "mtg",
    setCode: "DMU",
    setName: "Dominaria United",
    collectorNumber: "107",
    rarity: "Mythic",
    scryfallId: "d67be074-cdd4-41d9-ac89-0a0456c4e4b2",
    channels: ["POS" as const, "STOREFRONT" as const],
    variants: [
      { sku: "MTG-DMU-107-NM", priceCents: 7499, condition: "NM" as const, finish: "NONFOIL" as const, autoPrice: true },
      { sku: "MTG-DMU-107-NM-F", priceCents: 8999, condition: "NM" as const, finish: "FOIL" as const, autoPrice: true },
      { sku: "MTG-DMU-107-LP", priceCents: 6399, condition: "LP" as const, finish: "NONFOIL" as const, autoPrice: true },
    ],
  },
  {
    kind: "TCG_SINGLE" as const,
    title: "Charizard ex",
    game: "pokemon",
    setCode: "OBF",
    setName: "Obsidian Flames",
    collectorNumber: "125",
    pokemonTcgId: "sv3-125",
    channels: ["POS" as const, "STOREFRONT" as const],
    variants: [{ sku: "PKM-OBF-125-NM", priceCents: 2499, condition: "NM" as const, finish: "HOLO" as const, autoPrice: true }],
  },
  {
    kind: "TCG_SEALED" as const,
    title: "Bloomburrow Play Booster Box",
    game: "mtg",
    channels: ["POS" as const, "STOREFRONT" as const],
    variants: [{ sku: "MTG-BLB-PBB", barcode: "195166253070", priceCents: 14999 }],
  },
  {
    kind: "SNEAKER" as const,
    title: "Air Jordan 4 Retro Bred Reimagined",
    brand: "Jordan",
    styleCode: "FV5029-006",
    channels: ["POS" as const],
    variants: ["9", "9.5", "10", "10.5", "11"].map((size) => ({
      sku: `FV5029-006-${size}`,
      priceCents: 27500,
      size,
      itemCondition: "DS" as const,
    })),
  },
  {
    kind: "APPAREL" as const,
    title: "Box Logo Hoodie",
    brand: "Supreme",
    channels: ["POS" as const, "STOREFRONT" as const],
    variants: ["S", "M", "L", "XL"].map((size) => ({ sku: `SUP-BOGO-BLK-${size}`, priceCents: 45000, size, colorway: "Black" })),
  },
];

for (const { variants, ...p } of products) {
  const created = await prisma.product.create({ data: { ...p, variants: { create: variants } }, include: { variants: true } });
  for (const v of created.variants) {
    await prisma.inventoryLevel.create({ data: { variantId: v.id, locationId: location.id, onHand: 4 } });
    await prisma.inventoryMovement.create({ data: { variantId: v.id, locationId: location.id, delta: 4, reason: "RECEIVE", note: "Seed" } });
  }
}

await seedCategoriesAndDeals();

console.log(`Seeded location ${location.id}. Staff: owner@/manager@/cashier@mypos.local, PIN 1234`);
await prisma.$disconnect();
