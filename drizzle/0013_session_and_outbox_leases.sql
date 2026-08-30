CREATE TABLE "web_sessions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL,
  "oidc_subject" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "web_sessions_tenant_id_tenants_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id")
    ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "web_sessions_oidc_subject_users_oidc_subject_fk"
    FOREIGN KEY ("oidc_subject") REFERENCES "public"."users"("oidc_subject")
    ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "web_sessions_expiry_after_creation"
    CHECK ("web_sessions"."expires_at" > "web_sessions"."created_at")
);
--> statement-breakpoint
CREATE INDEX "web_sessions_tenant_expiry_idx"
ON "web_sessions" USING btree ("tenant_id", "expires_at");
--> statement-breakpoint
ALTER TABLE "web_sessions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation_web_sessions ON "web_sessions"
USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "lease_owner" text;
--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "lease_expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_lease_pair_complete"
CHECK (("outbox_events"."lease_owner" IS NULL) = ("outbox_events"."lease_expires_at" IS NULL));
--> statement-breakpoint
DROP INDEX "outbox_unpublished_idx";
--> statement-breakpoint
CREATE INDEX "outbox_unpublished_idx"
ON "outbox_events" USING btree ("published_at", "available_at", "lease_expires_at");
--> statement-breakpoint
CREATE FUNCTION claim_next_outbox(p_worker_id text)
RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  topic varchar,
  aggregate_type varchar,
  aggregate_id uuid,
  payload jsonb,
  idempotency_key varchar,
  attempts integer
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_worker_id IS NULL OR length(btrim(p_worker_id)) < 3 THEN
    RAISE EXCEPTION 'worker id is required';
  END IF;
  IF session_user <> 'taxops_worker' THEN
    RAISE EXCEPTION 'claim_next_outbox is restricted to taxops_worker';
  END IF;

  RETURN QUERY
  WITH candidate AS (
    SELECT pending.id
    FROM outbox_events pending
    WHERE pending.published_at IS NULL
      AND pending.attempts < 10
      AND (
        (pending.lease_owner IS NULL AND pending.available_at <= now())
        OR pending.lease_expires_at < now()
      )
    ORDER BY pending.available_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  ), claimed AS (
    UPDATE outbox_events pending
    SET attempts = pending.attempts + 1,
        lease_owner = p_worker_id,
        lease_expires_at = now() + interval '30 seconds',
        last_error_code = NULL
    FROM candidate
    WHERE pending.id = candidate.id
    RETURNING pending.id, pending.tenant_id, pending.topic,
              pending.aggregate_type, pending.aggregate_id, pending.payload,
              pending.idempotency_key, pending.attempts
  )
  SELECT claimed.id, claimed.tenant_id, claimed.topic,
         claimed.aggregate_type, claimed.aggregate_id, claimed.payload,
         claimed.idempotency_key, claimed.attempts
  FROM claimed;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION claim_next_outbox(text) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION claim_next_outbox()
RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  topic varchar,
  aggregate_type varchar,
  aggregate_id uuid,
  payload jsonb,
  idempotency_key varchar,
  attempts integer
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RETURN QUERY
  SELECT *
  FROM claim_next_outbox('legacy-worker-' || pg_backend_pid()::text);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION claim_next_outbox() FROM PUBLIC;
--> statement-breakpoint
DO $permissions$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'taxops_app') THEN
    GRANT SELECT, INSERT, DELETE ON web_sessions TO taxops_app;
    GRANT UPDATE (revoked_at) ON web_sessions TO taxops_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'taxops_worker') THEN
    GRANT EXECUTE ON FUNCTION claim_next_outbox(text) TO taxops_worker;
    GRANT EXECUTE ON FUNCTION claim_next_outbox() TO taxops_worker;
  END IF;
END;
$permissions$;
