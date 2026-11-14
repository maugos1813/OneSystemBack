CREATE TABLE "oauth_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event" varchar(30) NOT NULL,
	"user_id" uuid,
	"client_id" varchar(64),
	"detail" varchar(200),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" varchar(64) NOT NULL,
	"secret_hash" varchar(64) NOT NULL,
	"name" varchar(100) NOT NULL,
	"redirect_uris" text[] NOT NULL,
	"scopes" text[] NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_clients_client_id_unique" UNIQUE("client_id")
);
--> statement-breakpoint
CREATE TABLE "oauth_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code_hash" varchar(64) NOT NULL,
	"user_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" varchar(128) NOT NULL,
	"scope" varchar(200) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"grant_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_codes_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "oauth_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"scope" varchar(200) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "oauth_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grant_id" uuid NOT NULL,
	"access_hash" varchar(64) NOT NULL,
	"refresh_hash" varchar(64) NOT NULL,
	"access_expires_at" timestamp with time zone NOT NULL,
	"refresh_expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_tokens_access_hash_unique" UNIQUE("access_hash"),
	CONSTRAINT "oauth_tokens_refresh_hash_unique" UNIQUE("refresh_hash")
);
--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_grant_id_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."oauth_grants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_grant_id_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."oauth_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_audit_user_idx" ON "oauth_audit_log" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "oauth_grants_user_idx" ON "oauth_grants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_tokens_grant_idx" ON "oauth_tokens" USING btree ("grant_id");