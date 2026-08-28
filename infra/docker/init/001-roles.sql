-- Local integration credentials only. Production roles are provisioned by the platform team.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'taxops_app') THEN
    CREATE ROLE taxops_app LOGIN PASSWORD 'taxops_app_dev_only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'taxops_worker') THEN
    CREATE ROLE taxops_worker LOGIN PASSWORD 'taxops_worker_dev_only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'taxops_reviewer') THEN
    CREATE ROLE taxops_reviewer LOGIN PASSWORD 'taxops_reviewer_dev_only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END;
$$;
