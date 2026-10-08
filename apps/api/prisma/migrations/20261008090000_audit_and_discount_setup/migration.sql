-- CreateEnum
CREATE TYPE "DiscountKind" AS ENUM ('PERCENT', 'AMOUNT');

-- AlterTable
ALTER TABLE "AuditEvent" ADD COLUMN     "ip" TEXT,
ADD COLUMN     "status" INTEGER;

-- AlterTable
ALTER TABLE "OrderLine" ADD COLUMN     "discountNote" TEXT,
ADD COLUMN     "discountReason" TEXT,
ADD COLUMN     "discountReasonId" TEXT;

-- CreateTable
CREATE TABLE "DiscountReason" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "requiresNote" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiscountReason_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscountPreset" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "kind" "DiscountKind" NOT NULL,
    "value" INTEGER NOT NULL,
    "reasonId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiscountPreset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DiscountReason_name_key" ON "DiscountReason"("name");

