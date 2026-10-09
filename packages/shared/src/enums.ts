export const ProductKinds = [
  "TCG_SINGLE",
  "TCG_SEALED",
  "SNEAKER",
  "APPAREL",
  "COLLECTIBLE",
  "ACCESSORY",
  "EVENT_ENTRY",
] as const;
export type ProductKind = (typeof ProductKinds)[number];

export const CardConditions = ["NM", "LP", "MP", "HP", "DMG"] as const;
export type CardCondition = (typeof CardConditions)[number];

export const CardFinishes = ["NONFOIL", "FOIL", "ETCHED", "REVERSE_HOLO", "HOLO"] as const;
export type CardFinish = (typeof CardFinishes)[number];

export const CARD_CONDITION_LABELS: Record<CardCondition, string> = {
  NM: "Near Mint",
  LP: "Lightly Played",
  MP: "Moderately Played",
  HP: "Heavily Played",
  DMG: "Damaged",
};

/** Professional grading companies for slabbed cards. */
export const GradingCompanies = ["PSA", "BGS", "CGC", "SGC", "TAG", "ACE", "OTHER"] as const;
export type GradingCompany = (typeof GradingCompanies)[number];

/** "PSA 10", "BGS 9.5", "CGC Pristine 10". */
export const gradeLabel = (company: string | null | undefined, grade: string | null | undefined) =>
  company && grade ? `${company === "OTHER" ? "" : `${company} `}${grade}`.trim() : null;

/** Condition grades for sneakers / apparel. */
export const ItemConditions = ["DS", "VNDS", "USED", "DAMAGED"] as const;
export type ItemCondition = (typeof ItemConditions)[number];

/** Sneakers / streetwear: what customers see. DS = deadstock = new. */
export const ITEM_CONDITION_LABELS: Record<ItemCondition, string> = {
  DS: "New (DS)",
  VNDS: "Used, like new (VNDS)",
  USED: "Used",
  DAMAGED: "Used, damaged",
};

export const isNewItem = (c: ItemCondition | string | null | undefined) => c === "DS";

/** Product kinds sold new or used. */
export const NEW_OR_USED_KINDS = ["SNEAKER", "APPAREL"] as const;

export const SalesChannels = ["POS", "STOREFRONT", "SHOPIFY", "TCGPLAYER", "EBAY"] as const;
export type SalesChannel = (typeof SalesChannels)[number];

export const TenderTypes = ["CARD", "CASH", "CHECK", "STORE_CREDIT", "LOYALTY", "GIFT_CARD", "EXTERNAL"] as const;
export type TenderType = (typeof TenderTypes)[number];

export const BuylistPayouts = ["CASH", "STORE_CREDIT"] as const;
export type BuylistPayout = (typeof BuylistPayouts)[number];

export const StaffRoles = ["OWNER", "MANAGER", "CASHIER"] as const;
export type StaffRole = (typeof StaffRoles)[number];

/** EMPLOYEE: signs in at the register with a PIN. USER: signs in to the back-office website with a password. */
export const StaffKinds = ["EMPLOYEE", "USER"] as const;
export type StaffKind = (typeof StaffKinds)[number];

const APPAREL_SIZES = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "2XL", "XXXL", "3XL", "4XL"];

/** Shoe sizes numerically (4, 4.5 ... 13), youth sizes ("5Y") with numbers, then XS–XXL, then anything else. */
export function compareSizes(a: string, b: string): number {
  const num = (s: string) => {
    const m = /^(\d+(?:\.\d+)?)\s*([A-Za-z]*)$/.exec(s.trim());
    return m ? Number(m[1]) : null;
  };
  const na = num(a);
  const nb = num(b);
  if (na !== null && nb !== null) return na - nb || a.localeCompare(b);
  if (na !== null) return -1;
  if (nb !== null) return 1;
  const ia = APPAREL_SIZES.indexOf(a.toUpperCase());
  const ib = APPAREL_SIZES.indexOf(b.toUpperCase());
  if (ia >= 0 && ib >= 0) return ia - ib;
  if (ia >= 0) return -1;
  if (ib >= 0) return 1;
  return a.localeCompare(b);
}
