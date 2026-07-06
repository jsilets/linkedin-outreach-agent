CREATE TYPE "public"."campaign_step_type" AS ENUM('view_profile', 'connect', 'message', 'follow', 'react', 'delay');--> statement-breakpoint
CREATE TYPE "public"."progress_state" AS ENUM('pending', 'in_progress', 'completed', 'failed', 'skipped');--> statement-breakpoint
CREATE TABLE "campaign_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"step_order" integer NOT NULL,
	"step_type" "campaign_step_type" NOT NULL,
	"delay_seconds" integer DEFAULT 0 NOT NULL,
	"note" text,
	"body" text,
	"reaction" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "target_progress" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"current_step" integer DEFAULT 0 NOT NULL,
	"state" "progress_state" DEFAULT 'pending' NOT NULL,
	"next_step_at" timestamp with time zone,
	"last_step_at" timestamp with time zone,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaign_steps" ADD CONSTRAINT "campaign_steps_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "target_progress" ADD CONSTRAINT "target_progress_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "target_progress" ADD CONSTRAINT "target_progress_target_id_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."targets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "target_progress" ADD CONSTRAINT "target_progress_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_steps_order_idx" ON "campaign_steps" USING btree ("campaign_id","step_order");--> statement-breakpoint
CREATE UNIQUE INDEX "target_progress_target_idx" ON "target_progress" USING btree ("target_id");--> statement-breakpoint
CREATE INDEX "target_progress_due_idx" ON "target_progress" USING btree ("state","next_step_at");