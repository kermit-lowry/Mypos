-- AlterTable
ALTER TABLE "Staff" ADD COLUMN     "discountMaxBps" INTEGER,
ADD COLUMN     "permissionOverrides" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "pinLookup" TEXT;

-- CreateTable
CREATE TABLE "RolePolicy" (
    "role" "StaffRole" NOT NULL,
    "permissions" JSONB NOT NULL DEFAULT '{}',
    "discountMaxBps" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RolePolicy_pkey" PRIMARY KEY ("role")
);

-- CreateTable
CREATE TABLE "ApprovalGrant" (
    "id" TEXT NOT NULL,
    "approverId" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "permissions" TEXT[],
    "discountMaxBps" INTEGER NOT NULL,
    "reason" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "usedFor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "staffId" TEXT,
    "approverId" TEXT,
    "locationId" TEXT,
    "details" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ApprovalGrant_requesterId_createdAt_idx" ON "ApprovalGrant"("requesterId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_action_createdAt_idx" ON "AuditEvent"("action", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_staffId_createdAt_idx" ON "AuditEvent"("staffId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Staff_pinLookup_key" ON "Staff"("pinLookup");

