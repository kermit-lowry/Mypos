-- CreateEnum
CREATE TYPE "TaskRecurrence" AS ENUM ('ONCE', 'DAILY', 'WEEKLY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "TaskPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH');

-- CreateEnum
CREATE TYPE "TaskAssignee" AS ENUM ('ANYONE', 'ROLE', 'EMPLOYEE');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('OPEN', 'DONE', 'SKIPPED');

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "locationId" TEXT,
    "title" TEXT NOT NULL,
    "instructions" TEXT,
    "checklist" JSONB NOT NULL DEFAULT '[]',
    "priority" "TaskPriority" NOT NULL DEFAULT 'NORMAL',
    "recurrence" "TaskRecurrence" NOT NULL,
    "daysOfWeek" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "dayOfMonth" INTEGER,
    "dueTime" TEXT,
    "startsOn" DATE NOT NULL,
    "endsOn" DATE,
    "assigneeType" "TaskAssignee" NOT NULL DEFAULT 'ANYONE',
    "assigneeRole" "StaffRole",
    "assigneeId" TEXT,
    "requireNote" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskOccurrence" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "dueOn" DATE NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'OPEN',
    "checklistDone" JSONB NOT NULL DEFAULT '[]',
    "completedById" TEXT,
    "completedAt" TIMESTAMP(3),
    "late" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "skipReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskOccurrence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Task_locationId_active_idx" ON "Task"("locationId", "active");

-- CreateIndex
CREATE INDEX "TaskOccurrence_locationId_dueOn_status_idx" ON "TaskOccurrence"("locationId", "dueOn", "status");

-- CreateIndex
CREATE INDEX "TaskOccurrence_completedById_completedAt_idx" ON "TaskOccurrence"("completedById", "completedAt");

-- CreateIndex
CREATE UNIQUE INDEX "TaskOccurrence_taskId_locationId_dueOn_key" ON "TaskOccurrence"("taskId", "locationId", "dueOn");

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskOccurrence" ADD CONSTRAINT "TaskOccurrence_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskOccurrence" ADD CONSTRAINT "TaskOccurrence_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskOccurrence" ADD CONSTRAINT "TaskOccurrence_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

