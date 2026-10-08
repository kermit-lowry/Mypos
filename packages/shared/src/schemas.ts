import { z } from "zod";
import {
  BuylistPayouts,
  CardConditions,
  CardFinishes,
  ItemConditions,
  ProductKinds,
  SalesChannels,
  TenderTypes,
} from "./enums.js";
import { LoyaltyTypes, RewardTypes } from "./loyalty.js";

const cents = z.number().int().nonnegative();
const id = z.string().min(1);

export const VariantInput = z.object({
  sku: z.string().min(1),
  barcode: z.string().optional(),
  priceCents: cents,
  costCents: cents.optional(),
  taxable: z.boolean().default(true),
  // TCG singles
  condition: z.enum(CardConditions).optional(),
  finish: z.enum(CardFinishes).optional(),
  language: z.string().optional(),
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
  /** Which channels this product is published to. */
  channels: z.array(z.enum(SalesChannels)).default(["POS"]),
  variants: z.array(VariantInput).min(1),
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
  /** Overrides the variant price (requires MANAGER). */
  unitPriceCents: cents.optional(),
  discountCents: cents.default(0),
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
});
export type CheckoutInput = z.infer<typeof CheckoutInput>;

export const RefundInput = z.object({
  orderId: id,
  lines: z.array(z.object({ orderLineId: id, quantity: z.number().int().positive(), restock: z.boolean().default(true) })).min(1),
  /** Where the money goes. Defaults to original tenders, card first. */
  toStoreCredit: z.boolean().default(false),
  reason: z.string().optional(),
});
export type RefundInput = z.infer<typeof RefundInput>;

export const BuylistLineInput = z.object({
  /** Existing variant (preferred), or a description for items not yet in catalog. */
  variantId: id.optional(),
  description: z.string().optional(),
  quantity: z.number().int().positive(),
  marketCents: cents,
  /** Staff may override the computed offer. */
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
