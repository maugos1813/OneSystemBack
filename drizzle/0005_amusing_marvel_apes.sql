CREATE TABLE "organization_products" (
	"org_id" uuid NOT NULL,
	"product_key" text NOT NULL,
	"enabled_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_products_org_id_product_key_pk" PRIMARY KEY("org_id","product_key")
);
--> statement-breakpoint
ALTER TABLE "organization_products" ADD CONSTRAINT "organization_products_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;