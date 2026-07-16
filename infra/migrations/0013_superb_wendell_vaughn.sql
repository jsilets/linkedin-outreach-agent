ALTER TYPE "public"."progress_state" ADD VALUE 'withdrawn';--> statement-breakpoint
ALTER TYPE "public"."progress_state" ADD VALUE 'already_invited';--> statement-breakpoint
ALTER TABLE "actions" ADD COLUMN "detail" text;