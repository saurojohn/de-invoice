-- Tier 626: a rounding rule of the customer's and of the project's own
ALTER TABLE "Customer" ADD COLUMN "timeRoundingMinutes" INTEGER;
ALTER TABLE "Customer" ADD COLUMN "timeRoundingMode" TEXT;
ALTER TABLE "TimeProject" ADD COLUMN "timeRoundingMinutes" INTEGER;
ALTER TABLE "TimeProject" ADD COLUMN "timeRoundingMode" TEXT;
-- Tier 627: the pauses of a timer, kept on the entry it writes
ALTER TABLE "RunningTimer" ADD COLUMN "pauseCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "TimeEntry" ADD COLUMN "pauseCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "TimeEntry" ADD COLUMN "pausedSeconds" INTEGER NOT NULL DEFAULT 0;
