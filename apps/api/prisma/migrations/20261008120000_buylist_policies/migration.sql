-- CreateTable
CREATE TABLE "BuylistPolicy" (
    "id" TEXT NOT NULL,
    "kind" "ProductKind",
    "categoryId" TEXT,
    "cashMarginBps" INTEGER NOT NULL,
    "creditBonusBps" INTEGER NOT NULL,
    "trendWeightBps" INTEGER NOT NULL,
    "maxTrendUpBps" INTEGER NOT NULL,
    "overstockQty" INTEGER,
    "overstockCutBps" INTEGER NOT NULL DEFAULT 2000,
    "minResaleCents" INTEGER NOT NULL DEFAULT 100,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BuylistPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BuylistPolicy_kind_categoryId_key" ON "BuylistPolicy"("kind", "categoryId");

