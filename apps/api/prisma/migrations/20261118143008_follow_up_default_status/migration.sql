-- Separate migration: a new enum value must be committed before it is used.
ALTER TABLE "follow_up_jobs" ALTER COLUMN "status" SET DEFAULT 'DRAFTING';
