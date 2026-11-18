/*
  Warnings:

  - You are about to drop the column `tool_calls` on the `agent_runs` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "AgentTrigger" AS ENUM ('USER', 'LEAD_CREATED', 'INBOUND_MESSAGE', 'ORCHESTRATOR', 'SYSTEM');

-- CreateEnum
CREATE TYPE "ToolCallOutcome" AS ENUM ('EXECUTED', 'VALIDATION_FAILED', 'PERMISSION_DENIED', 'POLICY_BLOCKED', 'ERROR');

-- CreateEnum
CREATE TYPE "NotificationPriority" AS ENUM ('LOW', 'NORMAL', 'URGENT');

-- CreateEnum
CREATE TYPE "NotificationReason" AS ENUM ('HOT_LEAD', 'NEEDS_PRICING_DECISION', 'DISCOUNT_REQUEST', 'QUOTE_REQUEST', 'CUSTOM_REQUEST', 'COMPLAINT', 'OTHER');

-- AlterEnum
ALTER TYPE "AgentRunKind" ADD VALUE 'ORCHESTRATION';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "LeadEventType" ADD VALUE 'ANALYSIS_UPDATED';
ALTER TYPE "LeadEventType" ADD VALUE 'OWNER_NOTIFIED';

-- DropIndex
DROP INDEX "agent_runs_business_id_lead_id_idx";

-- AlterTable
ALTER TABLE "agent_runs" DROP COLUMN "tool_calls",
ADD COLUMN     "error_code" TEXT,
ADD COLUMN     "iterations" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "parent_run_id" UUID,
ADD COLUMN     "stop_reason" TEXT,
ADD COLUMN     "trigger" "AgentTrigger" NOT NULL DEFAULT 'USER',
ADD COLUMN     "triggered_by_id" UUID;

-- CreateTable
CREATE TABLE "agent_tool_calls" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "agent_run_id" UUID NOT NULL,
    "tool_use_id" TEXT NOT NULL,
    "tool_name" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "outcome" "ToolCallOutcome" NOT NULL,
    "result" JSONB,
    "error" TEXT,
    "duration_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_tool_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "lead_id" UUID,
    "agent_run_id" UUID,
    "priority" "NotificationPriority" NOT NULL DEFAULT 'NORMAL',
    "reason" "NotificationReason" NOT NULL,
    "message" TEXT NOT NULL,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_tool_calls_business_id_agent_run_id_created_at_idx" ON "agent_tool_calls"("business_id", "agent_run_id", "created_at");

-- CreateIndex
CREATE INDEX "notifications_business_id_read_at_created_at_idx" ON "notifications"("business_id", "read_at", "created_at");

-- CreateIndex
CREATE INDEX "notifications_business_id_lead_id_reason_created_at_idx" ON "notifications"("business_id", "lead_id", "reason", "created_at");

-- CreateIndex
CREATE INDEX "agent_runs_business_id_lead_id_status_idx" ON "agent_runs"("business_id", "lead_id", "status");

-- CreateIndex
CREATE INDEX "agent_runs_parent_run_id_idx" ON "agent_runs"("parent_run_id");

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_parent_run_id_fkey" FOREIGN KEY ("parent_run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_triggered_by_id_fkey" FOREIGN KEY ("triggered_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_tool_calls" ADD CONSTRAINT "agent_tool_calls_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_tool_calls" ADD CONSTRAINT "agent_tool_calls_agent_run_id_fkey" FOREIGN KEY ("agent_run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_agent_run_id_fkey" FOREIGN KEY ("agent_run_id") REFERENCES "agent_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
