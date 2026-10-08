-- AlterTable
ALTER TABLE "BuylistLine" ADD COLUMN     "offerNotes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "suggestedCashCents" INTEGER,
ADD COLUMN     "suggestedCreditCents" INTEGER;

