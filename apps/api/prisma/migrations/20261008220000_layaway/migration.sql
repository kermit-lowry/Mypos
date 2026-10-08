-- CreateEnum
CREATE TYPE "LayawayStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "MovementReason" ADD VALUE 'LAYAWAY';
ALTER TYPE "MovementReason" ADD VALUE 'LAYAWAY_RETURN';

-- AlterTable
ALTER TABLE "Location" ADD COLUMN     "layawayCancelFeeBps" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "layawayCancelFeeCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "layawayEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "layawayMinDepositBps" INTEGER NOT NULL DEFAULT 2000,
ADD COLUMN     "layawayTermDays" INTEGER NOT NULL DEFAULT 30;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "appliedCents" INTEGER,
ADD COLUMN     "layawayId" TEXT;

-- CreateTable
CREATE TABLE "Layaway" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "status" "LayawayStatus" NOT NULL DEFAULT 'ACTIVE',
    "locationId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "staffId" TEXT,
    "idempotencyKey" TEXT,
    "subtotalCents" INTEGER NOT NULL,
    "discountCents" INTEGER NOT NULL DEFAULT 0,
    "taxCents" INTEGER NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "cardPriceBps" INTEGER NOT NULL DEFAULT 0,
    "cardAdjustmentCents" INTEGER NOT NULL DEFAULT 0,
    "cardAdjustmentTaxCents" INTEGER NOT NULL DEFAULT 0,
    "paidCents" INTEGER NOT NULL DEFAULT 0,
    "appliedPromotions" JSONB NOT NULL DEFAULT '[]',
    "dueAt" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "orderId" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelFeeCents" INTEGER NOT NULL DEFAULT 0,
    "refundedCents" INTEGER NOT NULL DEFAULT 0,
    "cancelReason" TEXT,

    CONSTRAINT "Layaway_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LayawayLine" (
    "id" TEXT NOT NULL,
    "layawayId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPriceCents" INTEGER NOT NULL,
    "discountCents" INTEGER NOT NULL DEFAULT 0,
    "promoDiscountCents" INTEGER NOT NULL DEFAULT 0,
    "discountReasonId" TEXT,
    "discountReason" TEXT,
    "taxable" BOOLEAN NOT NULL,
    "costCents" INTEGER,

    CONSTRAINT "LayawayLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Layaway_number_key" ON "Layaway"("number");

-- CreateIndex
CREATE UNIQUE INDEX "Layaway_idempotencyKey_key" ON "Layaway"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Layaway_orderId_key" ON "Layaway"("orderId");

-- CreateIndex
CREATE INDEX "Layaway_locationId_status_idx" ON "Layaway"("locationId", "status");

-- CreateIndex
CREATE INDEX "Layaway_customerId_idx" ON "Layaway"("customerId");

-- CreateIndex
CREATE INDEX "Layaway_dueAt_idx" ON "Layaway"("dueAt");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_layawayId_fkey" FOREIGN KEY ("layawayId") REFERENCES "Layaway"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Layaway" ADD CONSTRAINT "Layaway_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Layaway" ADD CONSTRAINT "Layaway_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LayawayLine" ADD CONSTRAINT "LayawayLine_layawayId_fkey" FOREIGN KEY ("layawayId") REFERENCES "Layaway"("id") ON DELETE CASCADE ON UPDATE CASCADE;

