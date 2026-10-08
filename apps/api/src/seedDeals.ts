import { prisma } from "./db.js";

/** Demo categories and deals. Safe to run more than once. */
export async function seedCategoriesAndDeals() {
  const cat = async (name: string, parentId: string | null = null) =>
    (await prisma.category.findFirst({ where: { name, parentId } })) ?? prisma.category.create({ data: { name, parentId } });

  const tcg = await cat("Trading Cards");
  const mtg = await cat("Magic: The Gathering", tcg.id);
  const pokemon = await cat("Pokémon", tcg.id);
  const sealed = await cat("Sealed", tcg.id);
  const footwear = await cat("Sneakers");
  const apparel = await cat("Apparel");

  const assign = async (where: object, categoryId: string) => prisma.product.updateMany({ where, data: { categoryId } });
  await assign({ kind: "TCG_SINGLE", game: "mtg" }, mtg.id);
  await assign({ kind: "TCG_SINGLE", game: "pokemon" }, pokemon.id);
  await assign({ kind: "TCG_SEALED" }, sealed.id);
  await assign({ kind: "SNEAKER" }, footwear.id);
  await assign({ kind: "APPAREL" }, apparel.id);

  if ((await prisma.discountReason.count()) === 0) {
    for (const [i, [name, requiresNote]] of ([["Damaged / opened", false], ["Price match", true], ["Employee", false], ["Regular customer", false], ["Manager special", true]] as const).entries()) {
      await prisma.discountReason.create({ data: { name, requiresNote, sortOrder: i } });
    }
    const employee = await prisma.discountReason.findUniqueOrThrow({ where: { name: "Employee" } });
    await prisma.discountPreset.createMany({
      data: [
        { label: "5%", kind: "PERCENT", value: 500, sortOrder: 0 },
        { label: "10%", kind: "PERCENT", value: 1000, sortOrder: 1 },
        { label: "$5 off", kind: "AMOUNT", value: 500, sortOrder: 2 },
        { label: "Employee 20%", kind: "PERCENT", value: 2000, reasonId: employee.id, sortOrder: 3 },
      ],
    });
  }

  if ((await prisma.promotion.count()) === 0) {
    await prisma.promotion.createMany({
      data: [
        { name: "Singles BOGO 50%", type: "BUY_X_GET_Y", buyQty: 1, getQty: 1, getDiscountBps: 5000, categoryIds: [tcg.id], excludeCategoryIds: [sealed.id] },
        { name: "Friday Night 10% off sealed", type: "PERCENT_OFF", percentBps: 1000, categoryIds: [sealed.id], daysOfWeek: [5], startTime: "17:00", endTime: "23:00" },
        { name: "Spend $500 on kicks, save $25", type: "ORDER_DISCOUNT", amountCents: 2500, minSubtotalCents: 50_000, categoryIds: [footwear.id], channels: ["POS"] },
      ],
    });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await seedCategoriesAndDeals();
  console.log("Seeded categories and deals");
  await prisma.$disconnect();
}
