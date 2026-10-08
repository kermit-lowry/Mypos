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

/** Condition grades for sneakers / apparel. */
export const ItemConditions = ["DS", "VNDS", "USED", "DAMAGED"] as const;
export type ItemCondition = (typeof ItemConditions)[number];

export const SalesChannels = ["POS", "STOREFRONT", "SHOPIFY", "TCGPLAYER", "EBAY"] as const;
export type SalesChannel = (typeof SalesChannels)[number];

export const TenderTypes = ["CARD", "CASH", "STORE_CREDIT", "GIFT_CARD", "EXTERNAL"] as const;
export type TenderType = (typeof TenderTypes)[number];

export const BuylistPayouts = ["CASH", "STORE_CREDIT"] as const;
export type BuylistPayout = (typeof BuylistPayouts)[number];

export const StaffRoles = ["OWNER", "MANAGER", "CASHIER"] as const;
export type StaffRole = (typeof StaffRoles)[number];
