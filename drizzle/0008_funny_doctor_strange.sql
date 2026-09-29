ALTER TYPE "public"."user_role" ADD VALUE 'manager' BEFORE 'viewer';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "name" varchar(100) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "parent_user_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "allowed_area" varchar(50);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_parent_user_id_users_id_fk" FOREIGN KEY ("parent_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;