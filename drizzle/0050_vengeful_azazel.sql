CREATE TABLE "administrative_commands" (
	"organization_id" text NOT NULL,
	"command_id" uuid NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "administrative_commands_organization_id_command_id_pk" PRIMARY KEY("organization_id","command_id")
);
--> statement-breakpoint
ALTER TABLE "administrative_commands" ADD CONSTRAINT "administrative_commands_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;