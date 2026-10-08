-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "terminalId" TEXT;

-- AlterTable
ALTER TABLE "Terminal" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "model" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Terminal_gatewayRef_key" ON "Terminal"("gatewayRef");

