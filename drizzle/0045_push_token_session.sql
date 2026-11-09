ALTER TABLE "push_tokens" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "push_tokens" ADD CONSTRAINT "push_tokens_session_id_user_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."user_sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Phones registered before this carry no session: tie each to its person's most recent open app sign-in, so nobody loses their
-- notifications at the deploy. A phone with no open app session behind it is a phone that is already signed out: its row is dropped
-- at the next send (a phone only receives notifications while its session is open).
UPDATE "push_tokens" SET "session_id" = (
	SELECT "s"."id" FROM "user_sessions" "s"
	WHERE "s"."user_id" = "push_tokens"."user_id" AND "s"."client" = 'app' AND "s"."revoked_at" IS NULL
	ORDER BY "s"."last_used_at" DESC LIMIT 1
);
