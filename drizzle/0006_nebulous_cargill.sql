CREATE TABLE "user_products" (
	"user_id" uuid NOT NULL,
	"product_key" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_products_user_id_product_key_pk" PRIMARY KEY("user_id","product_key")
);
--> statement-breakpoint
ALTER TABLE "user_products" ADD CONSTRAINT "user_products_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;