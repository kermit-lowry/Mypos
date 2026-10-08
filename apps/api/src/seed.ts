/** Demo data: one store, three staff (PIN 1234), and a few TCG + sneaker products. */
import { prisma } from "./db.js";
import { brandFor } from "./services/brands.js";
import { seedCategoriesAndDeals } from "./seedDeals.js";
import { hashPin } from "./services/permissions.js";

const location = await prisma.location.create({ data: { name: "Main Street", taxRateBps: 825 } });
// PINs must be unique: they identify the employee at the register.
for (const [name, role, pin] of [["Owner", "OWNER", "1111"], ["Manager", "MANAGER", "2222"], ["Cashier", "CASHIER", "3333"]] as const) {
  await prisma.staff.create({ data: { name, email: `${role.toLowerCase()}@mypos.local`, role, ...(await hashPin(prisma, pin)) } });
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
  const brand = await brandFor(prisma, p.brand);
  const created = await prisma.product.create({ data: { ...p, brand: brand?.name, brandId: brand?.id, variants: { create: variants } }, include: { variants: true } });
  for (const v of created.variants) {
    await prisma.inventoryLevel.create({ data: { variantId: v.id, locationId: location.id, onHand: 4 } });
    await prisma.inventoryMovement.create({ data: { variantId: v.id, locationId: location.id, delta: 4, reason: "RECEIVE", note: "Seed" } });
  }
}

// Vendors, and which items each one supplies (an item can have several).
const vendors = await Promise.all([
  prisma.vendor.create({ data: { name: "Southern Hobby Supply", contactName: "Orders desk", email: "orders@southernhobby.example", phone: "615-555-0100", accountNumber: "SH-20418", website: "https://southernhobby.example" } }),
  prisma.vendor.create({ data: { name: "GTS Distribution", email: "sales@gts.example", phone: "425-555-0188", accountNumber: "GTS-7731" } }),
  prisma.vendor.create({ data: { name: "StockX (sourcing)", notes: "Resale sourcing; cost = winning bid + fees." } }),
]);
const allProducts = await prisma.product.findMany({ select: { id: true, kind: true, title: true } });
for (const p of allProducts) {
  if (p.kind === "TCG_SINGLE" || p.kind === "TCG_SEALED") {
    await prisma.productVendor.create({ data: { productId: p.id, vendorId: vendors[0]!.id, preferred: true, vendorSku: `SH-${p.id.slice(-6).toUpperCase()}`, leadDays: 3 } });
    if (p.kind === "TCG_SEALED") await prisma.productVendor.create({ data: { productId: p.id, vendorId: vendors[1]!.id, vendorSku: `GTS-${p.id.slice(-6).toUpperCase()}`, leadDays: 5 } });
  } else {
    await prisma.productVendor.create({ data: { productId: p.id, vendorId: vendors[2]!.id, preferred: true } });
  }
}

await seedCategoriesAndDeals();

// Employee tasks: what the sign-in screen shows (seeded once; a rerun of the seed starts from an empty database).
const [owner, cashier] = await Promise.all([prisma.staff.findFirstOrThrow({ where: { role: "OWNER" } }), prisma.staff.findFirstOrThrow({ where: { role: "CASHIER" } })]);
const startsOn = new Date("2026-10-01T00:00:00.000Z");
for (const t of [
  { title: "Opening checklist", recurrence: "DAILY" as const, priority: "HIGH" as const, dueTime: "10:30", checklist: ["Count the float", "Turn on the customer display", "Check online orders", "Wipe the glass case"] },
  { title: "Count the safe", recurrence: "WEEKLY" as const, daysOfWeek: [1], assigneeType: "ROLE" as const, assigneeRole: "MANAGER" as const, requireNote: true, dueTime: "12:00" },
  { title: "Inventory count: singles case", recurrence: "MONTHLY" as const, dayOfMonth: 1, assigneeType: "EMPLOYEE" as const, assigneeId: cashier.id, instructions: "Count every binder and the display case; note any discrepancies." },
]) {
  if (!(await prisma.task.findFirst({ where: { title: t.title, locationId: location.id } }))) {
    await prisma.task.create({ data: { ...t, locationId: location.id, startsOn, createdById: owner.id } });
  }
}

console.log(`Seeded location ${location.id}. PINs: owner 1111, manager 2222, cashier 3333`);
await prisma.$disconnect();
