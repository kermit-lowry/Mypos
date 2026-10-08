-- CreateEnum
CREATE TYPE "LoyaltyType" AS ENUM ('CASHBACK', 'POINTS');

-- CreateEnum
CREATE TYPE "LoyaltyUnit" AS ENUM ('CENTS', 'POINTS');

-- CreateEnum
CREATE TYPE "RewardType" AS ENUM ('PERCENT_OFF', 'AMOUNT_OFF', 'ITEM');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "loyaltyEarned" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "loyaltyEligibleCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "loyaltyUnit" "LoyaltyUnit",
ADD COLUMN     "pointsRedeemed" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "OrderLine" ADD COLUMN     "rewardDiscountCents" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "LoyaltyProgram" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "type" "LoyaltyType" NOT NULL DEFAULT 'POINTS',
    "cashbackBps" INTEGER NOT NULL DEFAULT 0,
    "pointsPerDollar" INTEGER NOT NULL DEFAULT 1,
    "excludedKinds" "ProductKind"[] DEFAULT ARRAY[]::"ProductKind"[],
    "earnOnCredit" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoyaltyProgram_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoyaltyReward" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "RewardType" NOT NULL,
    "pointsCost" INTEGER NOT NULL,
    "percentBps" INTEGER,
    "amountCents" INTEGER,
    "maxDiscountCents" INTEGER,
    "variantId" TEXT,
    "productId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoyaltyReward_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoyaltyEntry" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "unit" "LoyaltyUnit" NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "orderId" TEXT,
    "rewardId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoyaltyEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LoyaltyEntry_customerId_unit_idx" ON "LoyaltyEntry"("customerId", "unit");

-- AddForeignKey
ALTER TABLE "LoyaltyEntry" ADD CONSTRAINT "LoyaltyEntry_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

