DO $permissions$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'taxops_reviewer') THEN
    GRANT SELECT ON agent_runs TO taxops_reviewer;
  END IF;
END;
$permissions$;
