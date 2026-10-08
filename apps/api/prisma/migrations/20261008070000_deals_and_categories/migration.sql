-- CreateEnum
CREATE TYPE "PromotionType" AS ENUM ('PERCENT_OFF', 'AMOUNT_OFF', 'SALE_PRICE', 'BUY_X_GET_Y', 'MULTI_BUY', 'ORDER_DISCOUNT');

-- AlterTable
ALTER TABLE "Location" ADD COLUMN     "cardPricedTenders" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "appliedPromotions" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "OrderLine" ADD COLUMN     "promoDiscountCents" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "categoryId" TEXT;

-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Promotion" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "type" "PromotionType" NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "stackable" BOOLEAN NOT NULL DEFAULT false,
    "targetAll" BOOLEAN NOT NULL DEFAULT false,
    "productIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "variantIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "categoryIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "excludeProductIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "excludeCategoryIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "getProductIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "getVariantIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "getCategoryIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "percentBps" INTEGER,
    "amountCents" INTEGER,
    "priceCents" INTEGER,
    "buyQty" INTEGER,
    "getQty" INTEGER,
    "getDiscountBps" INTEGER,
    "minQty" INTEGER,
    "minSubtotalCents" INTEGER,
    "maxApplications" INTEGER,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "dates" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "daysOfWeek" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "startTime" TEXT,
    "endTime" TEXT,
    "channels" "SalesChannel"[] DEFAULT ARRAY['POS', 'STOREFRONT']::"SalesChannel"[],
    "locationIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Promotion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Category_parentId_name_key" ON "Category"("parentId", "name");

-- CreateIndex
CREATE INDEX "Product_categoryId_idx" ON "Product"("categoryId");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

