import { z } from "zod";
import {
  BuylistPayouts,
  CardConditions,
  CardFinishes,
  GradingCompanies,
  ItemConditions,
  ProductKinds,
  SalesChannels,
  TenderTypes,
} from "./enums.js";
import { LoyaltyTypes, RewardTypes } from "./loyalty.js";
import { PromotionTypes } from "./promotions.js";

const cents = z.number().int().nonnegative();
const id = z.string().min(1);

export const VariantInput = z.object({
  sku: z.string().min(1),
  barcode: z.string().optional(),
  priceCents: cents,
  costCents: cents.optional(),
  taxable: z.boolean().default(true),
  // TCG singles
  /** Raw (ungraded) card condition. */
  condition: z.enum(CardConditions).optional(),
  finish: z.enum(CardFinishes).optional(),
  language: z.string().optional(),
  /** Photo of this exact item; the product's image is used when empty. */
  imageUrl: z.string().url().optional(),
  /** Graded (slabbed) cards: company, grade as printed on the slab, and cert number. */
  gradingCompany: z.enum(GradingCompanies).optional(),
  grade: z.string().min(1).max(30).optional(),
  certNumber: z.string().min(3).max(40).optional(),
  // Sneakers / apparel
  size: z.string().optional(),
  colorway: z.string().optional(),
  itemCondition: z.enum(ItemConditions).optional(),
  /** Marks this variant as a one-of-one (e.g. a specific consigned pair). */
  serialized: z.boolean().default(false),
  /** Follow price-feed updates automatically. */
  autoPrice: z.boolean().default(false),
});
export type VariantInput = z.infer<typeof VariantInput>;

export const ProductInput = z.object({
  kind: z.enum(ProductKinds),
  title: z.string().min(1),
  brand: z.string().optional(),
  description: z.string().optional(),
  imageUrl: z.string().url().optional(),
  // TCG metadata
  game: z.string().optional(),
  setCode: z.string().optional(),
  setName: z.string().optional(),
  collectorNumber: z.string().optional(),
  rarity: z.string().optional(),
  scryfallId: z.string().optional(),
  tcgplayerId: z.string().optional(),
  pokemonTcgId: z.string().optional(),
  // Sneaker metadata
  styleCode: z.string().optional(),
  categoryId: z.string().optional(),
  /** Which channels this product is published to. */
  channels: z.array(z.enum(SalesChannels)).default(["POS"]),
  variants: z.array(VariantInput).min(1),
}).superRefine((p, ctx) => {
  p.variants.forEach((v, i) => {
    const path = ["variants", i];
    if (v.gradingCompany && !v.grade) ctx.addIssue({ code: "custom", path: [...path, "grade"], message: "Enter the grade on the slab" });
    if ((v.grade || v.certNumber) && !v.gradingCompany) ctx.addIssue({ code: "custom", path: [...path, "gradingCompany"], message: "Pick the grading company" });
    if (v.gradingCompany && v.condition) ctx.addIssue({ code: "custom", path: [...path, "condition"], message: "Graded cards use the grade, not a raw condition" });
  });
});
export type ProductInput = z.infer<typeof ProductInput>;

export const InventoryAdjustInput = z.object({
  variantId: id,
  locationId: id,
  delta: z.number().int(),
  reason: z.enum(["RECEIVE", "COUNT", "DAMAGE", "THEFT", "TRANSFER", "OTHER"]),
  note: z.string().optional(),
});
export type InventoryAdjustInput = z.infer<typeof InventoryAdjustInput>;

export const CartLine = z.object({
  variantId: id,
  quantity: z.number().int().positive(),
  /** Overrides the variant price (needs PRICE_OVERRIDE). */
  unitPriceCents: cents.optional(),
  /** Manual discount on the line (needs DISCOUNT_LINE, within the employee's limit). */
  discountCents: cents.default(0),
  /** Required with a manual discount when the store has discount reasons set up. */
  discountReasonId: z.string().optional(),
  discountNote: z.string().max(200).optional(),
  /** The discount button used, if any. Without one, the discount is a custom amount. */
  discountPresetId: z.string().optional(),
});
export type CartLine = z.infer<typeof CartLine>;

export const TenderInput = z.object({
  type: z.enum(TenderTypes),
  amountCents: z.number().int().positive(),
  /** Gateway token for card-not-present, or terminal id for card-present. */
  paymentToken: z.string().optional(),
  terminalId: z.string().optional(),
  /** For CASH: amount handed over, so change can be computed. */
  tenderedCents: cents.optional(),
  giftCardCode: z.string().optional(),
  reference: z.string().optional(),
});
export type TenderInput = z.infer<typeof TenderInput>;

export const CheckoutInput = z.object({
  locationId: id,
  channel: z.enum(SalesChannels).default("POS"),
  customerId: id.optional(),
  lines: z.array(CartLine).min(1),
  tenders: z.array(TenderInput).min(1),
  /** Client-generated idempotency key so retries on flaky store wifi never double-charge. */
  idempotencyKey: z.string().min(8),
  note: z.string().optional(),
  /** Points rewards to redeem on this sale (POINTS programs). */
  rewardIds: z.array(id).max(10).default([]),
  /** The register (its card terminal), so cash goes into that register's open drawer session. */
  terminalId: id.optional(),
});
export type CheckoutInput = z.infer<typeof CheckoutInput>;

export const RefundInput = z.object({
  orderId: id,
  lines: z.array(z.object({ orderLineId: id, quantity: z.number().int().positive(), restock: z.boolean().default(true) })).min(1),
  /** Where the money goes. Defaults to original tenders, card first. */
  toStoreCredit: z.boolean().default(false),
  reason: z.string().optional(),
  /** Card terminal to run card refunds on; defaults to the one that took the payment. */
  terminalId: id.optional(),
});
export type RefundInput = z.infer<typeof RefundInput>;

export const BuylistLineInput = z.object({
  /** Existing variant (preferred), or a description for items not yet in catalog. */
  variantId: id.optional(),
  description: z.string().optional(),
  quantity: z.number().int().positive(),
  /** What it resells for. Optional for catalog items (the store's rules work it out); needed for anything else. */
  marketCents: cents.optional(),
  /** Staff may override the computed offer (above the suggestion needs BUYLIST_OVERRIDE). */
  cashOfferCents: cents.optional(),
  creditOfferCents: cents.optional(),
});
export type BuylistLineInput = z.infer<typeof BuylistLineInput>;

export const BuylistQuoteInput = z.object({
  locationId: id,
  customerId: id.optional(),
  lines: z.array(BuylistLineInput).min(1),
});
export type BuylistQuoteInput = z.infer<typeof BuylistQuoteInput>;

export const BuylistAcceptInput = z.object({
  payout: z.enum(BuylistPayouts),
  customerId: id.optional(),
  /** Seller ID verification captured at the counter (required in many jurisdictions). */
  sellerIdType: z.string().optional(),
  sellerIdLast4: z.string().max(4).optional(),
  /** The register paying out, so a cash payout comes out of its open drawer session. */
  terminalId: id.optional(),
});
export type BuylistAcceptInput = z.infer<typeof BuylistAcceptInput>;

export const ConsignorInput = z.object({
  customerId: id,
  /** Store keeps this share of the sale price. */
  commissionBps: z.number().int().min(0).max(10_000),
});

export const ConsignInput = z.object({
  consignorId: id,
  variantId: id,
  locationId: id,
  quantity: z.number().int().positive().default(1),
  /** Seller's minimum acceptable price. */
  floorCents: cents.optional(),
});

export const AuthenticationInput = z.object({
  variantId: id,
  result: z.enum(["PASS", "FAIL", "INCONCLUSIVE"]),
  method: z.string().min(1),
  notes: z.string().optional(),
  photoUrls: z.array(z.string().url()).default([]),
});

export const EventInput = z.object({
  locationId: id,
  name: z.string().min(1),
  game: z.string().optional(),
  format: z.string().optional(),
  startsAt: z.coerce.date(),
  capacity: z.number().int().positive(),
  entryFeeCents: cents,
});
export type EventInput = z.infer<typeof EventInput>;

export const PreorderProductInput = z.object({
  variantId: id,
  releaseDate: z.coerce.date(),
  /** Max units sold before release; null = unlimited. */
  allocation: z.number().int().positive().nullable(),
  depositCents: cents,
  perCustomerLimit: z.number().int().positive().nullable().default(null),
});

export const PreorderInput = z.object({
  preorderProductId: id,
  customerId: id,
  quantity: z.number().int().positive(),
  locationId: id,
  tenders: z.array(TenderInput).min(1),
  idempotencyKey: z.string().min(8),
  /** The register taking the deposit, so cash goes into its open drawer session. */
  terminalId: id.optional(),
});
export type PreorderInput = z.infer<typeof PreorderInput>;

export const CustomerInput = z.object({
  name: z.string().min(1),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  /** e.g. Pokémon Player ID, Konami ID, Bandai ID — used for event reporting. */
  playerIds: z.record(z.string()).default({}),
});

export const LoyaltyProgramInput = z.object({
  enabled: z.boolean(),
  type: z.enum(LoyaltyTypes),
  cashbackBps: z.number().int().min(0).max(10_000).default(0),
  pointsPerDollar: z.number().int().min(0).max(1_000).default(1),
  excludedKinds: z.array(z.enum(ProductKinds)).default([]),
  earnOnCredit: z.boolean().default(false),
});
export type LoyaltyProgramInput = z.infer<typeof LoyaltyProgramInput>;

export const RewardInput = z
  .object({
    name: z.string().min(1),
    type: z.enum(RewardTypes),
    pointsCost: z.number().int().positive(),
    percentBps: z.number().int().min(1).max(10_000).optional(),
    amountCents: cents.optional(),
    maxDiscountCents: cents.optional(),
    variantId: id.optional(),
    productId: id.optional(),
    active: z.boolean().default(true),
  })
  .superRefine((r, ctx) => {
    if (r.type === "PERCENT_OFF" && !r.percentBps) ctx.addIssue({ code: "custom", path: ["percentBps"], message: "Required for % off" });
    if (r.type === "AMOUNT_OFF" && !r.amountCents) ctx.addIssue({ code: "custom", path: ["amountCents"], message: "Required for $ off" });
    if (r.type === "ITEM" && !r.variantId && !r.productId) ctx.addIssue({ code: "custom", path: ["variantId"], message: "Pick the item" });
  });
export type RewardInput = z.infer<typeof RewardInput>;

const ids = z.array(z.string().min(1)).max(500).default([]);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour HH:MM");

export const PromotionInput = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().max(500).optional(),
    active: z.boolean().default(true),
    type: z.enum(PromotionTypes),
    priority: z.number().int().min(0).max(10_000).default(100),
    stackable: z.boolean().default(false),

    targetAll: z.boolean().default(false),
    productIds: ids,
    variantIds: ids,
    categoryIds: ids,
    excludeProductIds: ids,
    excludeCategoryIds: ids,
    getProductIds: ids,
    getVariantIds: ids,
    getCategoryIds: ids,

    percentBps: z.number().int().min(1).max(10_000).optional(),
    amountCents: z.number().int().positive().optional(),
    priceCents: z.number().int().nonnegative().optional(),
    buyQty: z.number().int().min(1).max(100).optional(),
    getQty: z.number().int().min(1).max(100).optional(),
    getDiscountBps: z.number().int().min(1).max(10_000).optional(),
    minQty: z.number().int().min(1).optional(),
    minSubtotalCents: z.number().int().positive().optional(),
    maxApplications: z.number().int().min(1).optional(),

    startsAt: z.coerce.date().optional(),
    endsAt: z.coerce.date().optional(),
    dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(366).default([]),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7).default([]),
    startTime: hhmm.optional(),
    endTime: hhmm.optional(),

    channels: z.array(z.enum(SalesChannels)).min(1).default(["POS", "STOREFRONT"]),
    locationIds: ids,
  })
  .superRefine((p, ctx) => {
    const need = (field: keyof typeof p, msg: string) => p[field] == null && ctx.addIssue({ code: "custom", path: [field], message: msg });
    const hasTargets = p.targetAll || p.productIds.length + p.variantIds.length + p.categoryIds.length > 0;
    if (!hasTargets) ctx.addIssue({ code: "custom", path: ["targetAll"], message: "Pick products, categories, or everything" });
    if (p.type === "PERCENT_OFF") need("percentBps", "Set the % off");
    if (p.type === "AMOUNT_OFF") need("amountCents", "Set the $ off");
    if (p.type === "SALE_PRICE") need("priceCents", "Set the sale price");
    if (p.type === "BUY_X_GET_Y") {
      need("buyQty", "How many to buy");
      need("getQty", "How many they get");
    }
    if (p.type === "MULTI_BUY") {
      need("buyQty", "How many items");
      need("priceCents", "Price for the group");
    }
    if (p.type === "ORDER_DISCOUNT" && p.percentBps == null && p.amountCents == null) {
      ctx.addIssue({ code: "custom", path: ["percentBps"], message: "Set a % or $ off" });
    }
    if ((p.startTime == null) !== (p.endTime == null)) ctx.addIssue({ code: "custom", path: ["endTime"], message: "Set both start and end times" });
    if (p.startsAt && p.endsAt && p.endsAt <= p.startsAt) ctx.addIssue({ code: "custom", path: ["endsAt"], message: "End must be after start" });
  });
export type PromotionInput = z.infer<typeof PromotionInput>;

export const DiscountReasonInput = z.object({
  name: z.string().min(1).max(60),
  requiresNote: z.boolean().default(false),
  active: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});

export const DiscountPresetInput = z
  .object({
    label: z.string().min(1).max(30),
    kind: z.enum(["PERCENT", "AMOUNT"]),
    /** bps for PERCENT (1000 = 10%), cents for AMOUNT. */
    value: z.number().int().positive(),
    reasonId: z.string().nullable().optional(),
    active: z.boolean().default(true),
    sortOrder: z.number().int().default(0),
  })
  .refine((p) => p.kind !== "PERCENT" || p.value <= 10_000, { path: ["value"], message: "Can't be more than 100%" });

export const BuylistPolicyInput = z.object({
  /** Leave both empty for the store default. */
  kind: z.enum(ProductKinds).nullable().default(null),
  categoryId: z.string().nullable().default(null),
  cashMarginBps: z.number().int().min(0).max(10_000),
  creditBonusBps: z.number().int().min(0).max(10_000),
  trendWeightBps: z.number().int().min(0).max(20_000),
  maxTrendUpBps: z.number().int().min(0).max(10_000),
  overstockQty: z.number().int().positive().nullable().default(null),
  overstockCutBps: z.number().int().min(0).max(10_000).default(2000),
  minResaleCents: z.number().int().min(0).default(100),
});
export type BuylistPolicyInput = z.infer<typeof BuylistPolicyInput>;
