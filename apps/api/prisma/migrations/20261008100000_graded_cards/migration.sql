-- CreateEnum
CREATE TYPE "GradingCompany" AS ENUM ('PSA', 'BGS', 'CGC', 'SGC', 'TAG', 'ACE', 'OTHER');

-- AlterTable
ALTER TABLE "Variant" ADD COLUMN     "certNumber" TEXT,
ADD COLUMN     "grade" TEXT,
ADD COLUMN     "gradingCompany" "GradingCompany";

-- CreateIndex
CREATE UNIQUE INDEX "Variant_gradingCompany_certNumber_key" ON "Variant"("gradingCompany", "certNumber");

