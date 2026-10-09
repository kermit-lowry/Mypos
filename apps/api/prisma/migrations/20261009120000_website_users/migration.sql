-- CreateEnum
CREATE TYPE "StaffKind" AS ENUM ('EMPLOYEE', 'USER');

-- DropIndex
DROP INDEX "Staff_email_key";

-- AlterTable
ALTER TABLE "Staff" ADD COLUMN     "kind" "StaffKind" NOT NULL DEFAULT 'EMPLOYEE',
ADD COLUMN     "lastLoginAt" TIMESTAMP(3),
ALTER COLUMN "email" DROP NOT NULL,
ALTER COLUMN "pinHash" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "Staff_kind_active_idx" ON "Staff"("kind", "active");

-- CreateIndex
CREATE UNIQUE INDEX "Staff_kind_email_key" ON "Staff"("kind", "email");


-- Data move: every existing row stays an EMPLOYEE. Each owner or manager who
-- had a website password (and an email to sign in with) gets a separate USER
-- row with the same name, email, role and password, so they keep signing in
-- to the back office. Employees then lose their password: the register uses
-- the PIN. Cashiers who had a password simply lose website access (cashiers
-- aren't a website role); an owner can make them a user account if needed.
WITH copies AS (
  INSERT INTO "Staff" ("id", "kind", "name", "email", "role", "active", "passwordHash", "pinHash", "pinLookup", "permissionOverrides", "discountMaxBps", "createdAt")
  SELECT 'usr' || substr(md5(random()::text || "id"), 1, 22), 'USER', "name", "email", "role", "active", "passwordHash", NULL, NULL, '{}', NULL, "createdAt"
  FROM "Staff"
  WHERE "kind" = 'EMPLOYEE' AND "passwordHash" IS NOT NULL AND "email" IS NOT NULL AND "role" IN ('OWNER', 'MANAGER')
  RETURNING "id"
)
UPDATE "Staff" SET "passwordHash" = NULL WHERE "kind" = 'EMPLOYEE' AND "passwordHash" IS NOT NULL;
