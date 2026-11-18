-- CreateEnum
CREATE TYPE "EmailDeliveryStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED');

-- AlterEnum
ALTER TYPE "FollowUpStatus" ADD VALUE 'DRAFTING';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "LeadEventType" ADD VALUE 'FOLLOW_UP_DRAFTED';
ALTER TYPE "LeadEventType" ADD VALUE 'FOLLOW_UP_RESCHEDULED';
ALTER TYPE "LeadEventType" ADD VALUE 'FOLLOW_UP_SKIPPED';
ALTER TYPE "LeadEventType" ADD VALUE 'FOLLOW_UP_FAILED';
ALTER TYPE "LeadEventType" ADD VALUE 'MESSAGE_FAILED';

-- AlterEnum
ALTER TYPE "MessageStatus" ADD VALUE 'CANCELLED';

-- AlterTable
ALTER TABLE "follow_up_jobs" ADD COLUMN     "anchor_message_id" UUID,
ADD COLUMN     "draft_run_id" UUID,
ADD COLUMN     "last_error" TEXT;

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "last_inbound_at" TIMESTAMP(3),
ADD COLUMN     "last_outbound_at" TIMESTAMP(3),
ADD COLUMN     "reply_token" UUID NOT NULL DEFAULT gen_random_uuid(),
ADD COLUMN     "unsubscribe_token" UUID NOT NULL DEFAULT gen_random_uuid();

-- CreateTable
CREATE TABLE "email_deliveries" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "to_address" TEXT NOT NULL,
    "status" "EmailDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "provider_message_id" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_deliveries_message_id_key" ON "email_deliveries"("message_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_deliveries_idempotency_key_key" ON "email_deliveries"("idempotency_key");

-- CreateIndex
CREATE INDEX "email_deliveries_business_id_status_created_at_idx" ON "email_deliveries"("business_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "leads_unsubscribe_token_key" ON "leads"("unsubscribe_token");

-- CreateIndex
CREATE UNIQUE INDEX "leads_reply_token_key" ON "leads"("reply_token");

-- CreateIndex
CREATE INDEX "leads_status_last_outbound_at_idx" ON "leads"("status", "last_outbound_at");

-- AddForeignKey
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

