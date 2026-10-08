-- AlterTable
ALTER TABLE "Location" ADD COLUMN     "cardPriceBps" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "labelPrinterHost" TEXT,
ADD COLUMN     "receiptFooter" TEXT,
ADD COLUMN     "receiptHeader" TEXT;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "cardAdjustmentCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "cardAdjustmentTaxCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "cardPriceBps" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "CustomerDisplay" (
    "channel" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerDisplay_pkey" PRIMARY KEY ("channel")
);

