CREATE TABLE "run_cancellations" (
	"trigger_run_id" uuid PRIMARY KEY NOT NULL,
	"command_id" uuid NOT NULL,
	"requested_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_api_keys" DROP CONSTRAINT "organization_api_keys_scopes_check";--> statement-breakpoint
ALTER TABLE "agent_executions" ADD COLUMN "hub_action_disposition" text;--> statement-breakpoint
ALTER TABLE "run_cancellations" ADD CONSTRAINT "run_cancellations_trigger_run_id_trigger_runs_id_fk" FOREIGN KEY ("trigger_run_id") REFERENCES "public"."trigger_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_api_keys" ADD CONSTRAINT "organization_api_keys_scopes_check" CHECK ("organization_api_keys"."scopes" <@ ARRAY['projects:read', 'configuration:validate', 'configuration:install', 'runs:dispatch', 'runs:read', 'runs:cancel', 'daemons:enroll']::text[] and cardinality("organization_api_keys"."scopes") > 0);