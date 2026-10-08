-- CreateEnum
CREATE TYPE "DrawerSessionStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "CashMovementKind" AS ENUM ('PAID_IN', 'PAID_OUT', 'DROP');

-- AlterTable
ALTER TABLE "BuylistTicket" ADD COLUMN     "drawerSessionId" TEXT;

-- AlterTable
ALTER TABLE "Location" ADD COLUMN     "blindCashCount" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "cashVarianceAlertCents" INTEGER NOT NULL DEFAULT 500,
ADD COLUMN     "requireDrawerSession" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "drawerSessionId" TEXT;

-- CreateTable
CREATE TABLE "DrawerSession" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "status" "DrawerSessionStatus" NOT NULL DEFAULT 'OPEN',
    "locationId" TEXT NOT NULL,
    "terminalId" TEXT,
    "openedById" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openingFloatCents" INTEGER NOT NULL DEFAULT 0,
    "openingCount" JSONB,
    "closedById" TEXT,
    "closedAt" TIMESTAMP(3),
    "expectedCashCents" INTEGER,
    "countedCashCents" INTEGER,
    "varianceCents" INTEGER,
    "closingCount" JSONB,
    "approvedById" TEXT,
    "closingReport" JSONB,
    "notes" TEXT,

    CONSTRAINT "DrawerSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashMovement" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "kind" "CashMovementKind" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "staffId" TEXT,
    "approverId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimeEntry" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "clockIn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clockOut" TIMESTAMP(3),
    "breakMinutes" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "source" TEXT NOT NULL DEFAULT 'register',
    "editedById" TEXT,
    "editedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TimeEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DrawerSession_number_key" ON "DrawerSession"("number");

-- CreateIndex
CREATE INDEX "DrawerSession_locationId_status_idx" ON "DrawerSession"("locationId", "status");

-- CreateIndex
CREATE INDEX "DrawerSession_terminalId_status_idx" ON "DrawerSession"("terminalId", "status");

-- CreateIndex
CREATE INDEX "DrawerSession_openedAt_idx" ON "DrawerSession"("openedAt");

-- CreateIndex
CREATE INDEX "CashMovement_sessionId_idx" ON "CashMovement"("sessionId");

-- CreateIndex
CREATE INDEX "TimeEntry_staffId_clockIn_idx" ON "TimeEntry"("staffId", "clockIn");

-- CreateIndex
CREATE INDEX "TimeEntry_locationId_clockIn_idx" ON "TimeEntry"("locationId", "clockIn");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_drawerSessionId_fkey" FOREIGN KEY ("drawerSessionId") REFERENCES "DrawerSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuylistTicket" ADD CONSTRAINT "BuylistTicket_drawerSessionId_fkey" FOREIGN KEY ("drawerSessionId") REFERENCES "DrawerSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DrawerSession" ADD CONSTRAINT "DrawerSession_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DrawerSession" ADD CONSTRAINT "DrawerSession_openedById_fkey" FOREIGN KEY ("openedById") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DrawerSession" ADD CONSTRAINT "DrawerSession_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "DrawerSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

