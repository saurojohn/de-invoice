-- Tier 623: a running timer can be paused
ALTER TABLE "RunningTimer" ADD COLUMN "pausedAt" TIMESTAMP(3);
ALTER TABLE "RunningTimer" ADD COLUMN "pausedSeconds" INTEGER NOT NULL DEFAULT 0;
