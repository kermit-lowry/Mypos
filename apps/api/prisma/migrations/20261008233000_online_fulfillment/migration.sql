-- CreateEnum
CREATE TYPE "FulfillmentMethod" AS ENUM ('PICKUP', 'SHIP');

-- CreateEnum
CREATE TYPE "FulfillmentStatus" AS ENUM ('NEW', 'ACKNOWLEDGED', 'PICKING', 'READY', 'SHIPPED', 'PICKED_UP', 'PROBLEM');

-- AlterTable
ALTER TABLE "Location" ADD COLUMN     "onlineFreeShippingOverCents" INTEGER,
ADD COLUMN     "onlinePickupEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "onlineShippingEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "onlineShippingFlatCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pickupInstructions" TEXT;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "acknowledgedAt" TIMESTAMP(3),
ADD COLUMN     "carrier" TEXT,
ADD COLUMN     "customerNote" TEXT,
ADD COLUMN     "customerPhone" TEXT,
ADD COLUMN     "fulfilledById" TEXT,
ADD COLUMN     "fulfillment" "FulfillmentMethod",
ADD COLUMN     "fulfillmentStatus" "FulfillmentStatus",
ADD COLUMN     "pickedLineIds" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "pickedUpAt" TIMESTAMP(3),
ADD COLUMN     "readyAt" TIMESTAMP(3),
ADD COLUMN     "shippedAt" TIMESTAMP(3),
ADD COLUMN     "shippingAddress" JSONB,
ADD COLUMN     "shippingCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "trackingNumber" TEXT;

-- CreateIndex
CREATE INDEX "Order_locationId_fulfillmentStatus_idx" ON "Order"("locationId", "fulfillmentStatus");

