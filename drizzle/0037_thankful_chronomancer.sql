CREATE TABLE "fleets" (
	"org_id" uuid NOT NULL,
	"name" varchar(50) NOT NULL,
	"logo" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fleets_org_id_name_pk" PRIMARY KEY("org_id","name")
);
--> statement-breakpoint
ALTER TABLE "fleets" ADD CONSTRAINT "fleets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;