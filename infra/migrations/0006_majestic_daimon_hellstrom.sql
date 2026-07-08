ALTER TABLE "accounts" ALTER COLUMN "state" SET DEFAULT 'Active';--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN "warmup_day";