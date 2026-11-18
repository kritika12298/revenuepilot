-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('PROPOSED', 'CONFIRMED', 'CANCELLED', 'COMPLETED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "KnowledgeType" AS ENUM ('SERVICE', 'FAQ', 'BUSINESS_INFO', 'CONTACT', 'LOCATION', 'POLICY');

-- CreateEnum
CREATE TYPE "KnowledgeSource" AS ENUM ('WEBSITE', 'OWNER');

-- CreateEnum
CREATE TYPE "KnowledgeStatus" AS ENUM ('PENDING_REVIEW', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "WebsiteStatus" AS ENUM ('QUEUED', 'FETCHING', 'ANALYZING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "RecommendationStatus" AS ENUM ('OPEN', 'DONE', 'DISMISSED');

-- CreateEnum
CREATE TYPE "IntegrationStatus" AS ENUM ('NOT_CONFIGURED', 'CONNECTED', 'ERROR', 'DISABLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AgentRunKind" ADD VALUE 'MEETING';
ALTER TYPE "AgentRunKind" ADD VALUE 'FOLLOW_UP_PLANNING';
ALTER TYPE "AgentRunKind" ADD VALUE 'POLICY_CHECK';
ALTER TYPE "AgentRunKind" ADD VALUE 'WEBSITE_ANALYSIS';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ApprovalType" ADD VALUE 'CONTRACT';
ALTER TYPE "ApprovalType" ADD VALUE 'CUSTOM_PRICE';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "LeadEventType" ADD VALUE 'POLICY_DECISION';
ALTER TYPE "LeadEventType" ADD VALUE 'ASSIGNED';
ALTER TYPE "LeadEventType" ADD VALUE 'APPOINTMENT_PROPOSED';
ALTER TYPE "LeadEventType" ADD VALUE 'APPOINTMENT_BOOKED';
ALTER TYPE "LeadEventType" ADD VALUE 'APPOINTMENT_RESCHEDULED';
ALTER TYPE "LeadEventType" ADD VALUE 'APPOINTMENT_CANCELLED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationReason" ADD VALUE 'OVERDUE_FOLLOW_UP';
ALTER TYPE "NotificationReason" ADD VALUE 'RECOMMENDATION';
ALTER TYPE "NotificationReason" ADD VALUE 'APPOINTMENT';
ALTER TYPE "NotificationReason" ADD VALUE 'WEBSITE_ANALYSIS';
ALTER TYPE "NotificationReason" ADD VALUE 'INTEGRATION_ERROR';

-- AlterTable
ALTER TABLE "agent_runs" ADD COLUMN     "job_attempt" INTEGER,
ADD COLUMN     "trigger_detail" TEXT;

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "assigned_to_id" UUID,
ADD COLUMN     "deal_value_cents" INTEGER;

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "dedupe_key" TEXT;

-- CreateTable
CREATE TABLE "appointments" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "service_id" UUID,
    "title" TEXT NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "status" "AppointmentStatus" NOT NULL DEFAULT 'PROPOSED',
    "location" TEXT,
    "notes" TEXT,
    "calendar_provider" TEXT NOT NULL DEFAULT 'mock',
    "external_event_id" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "booked_by" "ActorType" NOT NULL,
    "agent_run_id" UUID,
    "reminder_sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_websites" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "status" "WebsiteStatus" NOT NULL DEFAULT 'QUEUED',
    "pages_fetched" INTEGER NOT NULL DEFAULT 0,
    "pages" JSONB NOT NULL DEFAULT '[]',
    "summary" TEXT,
    "missing_info" JSONB NOT NULL DEFAULT '[]',
    "last_error" TEXT,
    "last_sync_at" TIMESTAMP(3),
    "agent_run_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "business_websites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_items" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "website_id" UUID,
    "type" "KnowledgeType" NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "price_text" TEXT,
    "source" "KnowledgeSource" NOT NULL,
    "status" "KnowledgeStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "source_url" TEXT,
    "evidence" TEXT,
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "autonomy_policies" (
    "business_id" UUID NOT NULL,
    "auto_score_leads" BOOLEAN NOT NULL DEFAULT true,
    "auto_generate_responses" BOOLEAN NOT NULL DEFAULT true,
    "auto_send_responses" BOOLEAN NOT NULL DEFAULT false,
    "auto_schedule_follow_ups" BOOLEAN NOT NULL DEFAULT true,
    "auto_approve_follow_ups" BOOLEAN NOT NULL DEFAULT false,
    "auto_book_appointments" BOOLEAN NOT NULL DEFAULT false,
    "max_auto_emails_per_day" INTEGER NOT NULL DEFAULT 50,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "autonomy_policies_pkey" PRIMARY KEY ("business_id")
);

-- CreateTable
CREATE TABLE "recommendations" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "lead_id" UUID,
    "type" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "priority" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "suggested_action" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "impact" JSONB,
    "status" "RecommendationStatus" NOT NULL DEFAULT 'OPEN',
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_connections" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "status" "IntegrationStatus" NOT NULL DEFAULT 'NOT_CONFIGURED',
    "config" JSONB NOT NULL DEFAULT '{}',
    "secrets_enc" TEXT,
    "last_sync_at" TIMESTAMP(3),
    "last_error" TEXT,
    "connected_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "actor_type" "ActorType" NOT NULL,
    "actor_user_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "appointments_idempotency_key_key" ON "appointments"("idempotency_key");

-- CreateIndex
CREATE INDEX "appointments_business_id_starts_at_idx" ON "appointments"("business_id", "starts_at");

-- CreateIndex
CREATE INDEX "appointments_lead_id_idx" ON "appointments"("lead_id");

-- CreateIndex
CREATE UNIQUE INDEX "business_websites_business_id_key" ON "business_websites"("business_id");

-- CreateIndex
CREATE INDEX "knowledge_items_business_id_status_type_idx" ON "knowledge_items"("business_id", "status", "type");

-- CreateIndex
CREATE INDEX "recommendations_business_id_status_priority_idx" ON "recommendations"("business_id", "status", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "recommendations_business_id_dedupe_key_key" ON "recommendations"("business_id", "dedupe_key");

-- CreateIndex
CREATE UNIQUE INDEX "integration_connections_business_id_provider_key" ON "integration_connections"("business_id", "provider");

-- CreateIndex
CREATE INDEX "audit_logs_business_id_created_at_idx" ON "audit_logs"("business_id", "created_at");

-- CreateIndex
CREATE INDEX "leads_business_id_assigned_to_id_idx" ON "leads"("business_id", "assigned_to_id");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_business_id_dedupe_key_key" ON "notifications"("business_id", "dedupe_key");

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_assigned_to_id_fkey" FOREIGN KEY ("assigned_to_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_websites" ADD CONSTRAINT "business_websites_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "business_websites"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "autonomy_policies" ADD CONSTRAINT "autonomy_policies_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

