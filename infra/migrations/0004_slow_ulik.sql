CREATE TABLE "lead_list_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"list_id" uuid NOT NULL,
	"linkedin_urn" text NOT NULL,
	"name" text,
	"headline" text,
	"profile_url" text,
	"degree" text,
	"location" text,
	"current_company" text,
	"external_context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_lists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lead_list_members" ADD CONSTRAINT "lead_list_members_list_id_lead_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."lead_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lead_list_members_list_urn_uq" ON "lead_list_members" USING btree ("list_id","linkedin_urn");