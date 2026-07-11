ALTER TYPE "public"."message_status" ADD VALUE 'rejected' BEFORE 'sent';--> statement-breakpoint
ALTER TYPE "public"."message_status" ADD VALUE 'cancelled' BEFORE 'sent';