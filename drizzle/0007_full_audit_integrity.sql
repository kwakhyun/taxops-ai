CREATE FUNCTION verify_audit_chain_integrity(p_tenant uuid)
RETURNS TABLE(
  valid boolean,
  event_count bigint,
  root_previous_hash text,
  head_hash text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF session_user NOT IN ('taxops_app', 'taxops_reviewer')
     OR p_tenant IS NULL
     OR nullif(current_setting('app.tenant_id', true), '')::uuid
        IS DISTINCT FROM p_tenant THEN
    RAISE insufficient_privilege
      USING MESSAGE = 'audit verifier tenant context is not allowed';
  END IF;

  RETURN QUERY
  WITH ordered_events AS (
    SELECT
      event.*,
      lag(event.hash) OVER (
        ORDER BY event.occurred_at ASC, event.id ASC
      ) AS expected_previous_hash
    FROM public.audit_events event
    WHERE event.tenant_id = p_tenant
  ), checked_events AS (
    SELECT
      event.*,
      CASE
        WHEN event.expected_previous_hash IS NULL
          THEN event.previous_hash = repeat('0', 64)
        ELSE event.previous_hash = event.expected_previous_hash
      END AS link_is_valid,
      event.hash = encode(
        digest(
          convert_to(
            concat_ws(
              chr(31), event.previous_hash, event.tenant_id::text,
              event.actor_id, event.action, event.target_type,
              event.target_id, event.outcome::text,
              to_char(
                event.occurred_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              ),
              event.trace_id,
              public.canonical_audit_metadata(event.metadata)
            ),
            'UTF8'
          ),
          'sha256'
        ),
        'hex'
      ) AS payload_is_valid
    FROM ordered_events event
  )
  SELECT
    count(*) > 0
      AND COALESCE(bool_and(event.link_is_valid), false)
      AND COALESCE(bool_and(event.payload_is_valid), false) AS valid,
    count(*)::bigint AS event_count,
    (array_agg(
      event.previous_hash ORDER BY event.occurred_at ASC, event.id ASC
    ))[1] AS root_previous_hash,
    (array_agg(
      event.hash ORDER BY event.occurred_at DESC, event.id DESC
    ))[1] AS head_hash
  FROM checked_events event;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION verify_audit_chain_integrity(uuid) FROM PUBLIC;
--> statement-breakpoint
DO $permissions$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'taxops_app') THEN
    GRANT EXECUTE ON FUNCTION verify_audit_chain_integrity(uuid) TO taxops_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'taxops_reviewer') THEN
    GRANT EXECUTE ON FUNCTION verify_audit_chain_integrity(uuid) TO taxops_reviewer;
  END IF;
END;
$permissions$;
