CREATE SCHEMA IF NOT EXISTS workbench;
SET LOCAL search_path TO workbench;

CREATE TABLE tasks (
  id serial PRIMARY KEY,
  name text UNIQUE NOT NULL,
  goal text NOT NULL,
  tools text[] NOT NULL,
  schedule text,
  folders text[] NOT NULL DEFAULT '{}',
  domains text[] NOT NULL DEFAULT '{}',
  max_steps int NOT NULL DEFAULT 12,
  on_untrusted_write text NOT NULL DEFAULT 'approve' CHECK (on_untrusted_write IN ('approve', 'block')),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id int NOT NULL REFERENCES tasks(id),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'waiting_approval', 'succeeded', 'failed')),
  trigger text NOT NULL,
  scheduled_for timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  messages jsonb NOT NULL DEFAULT '[]',
  pending jsonb,
  tainted boolean NOT NULL DEFAULT false,
  steps int NOT NULL DEFAULT 0,
  tokens_in int NOT NULL DEFAULT 0,
  tokens_out int NOT NULL DEFAULT 0,
  result text,
  error text,
  worker text
);
-- A schedule slot can only ever produce one run, however many schedulers are running.
CREATE UNIQUE INDEX runs_schedule_once ON runs (task_id, scheduled_for) WHERE scheduled_for IS NOT NULL;
-- The database itself guarantees a task never has two runs executing at once.
CREATE UNIQUE INDEX runs_one_running_per_task ON runs (task_id) WHERE status = 'running';
CREATE INDEX runs_status_idx ON runs (status, created_at);

CREATE TABLE steps (
  id bigserial PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq int NOT NULL,
  kind text NOT NULL CHECK (kind IN ('model', 'tool')),
  name text,
  input jsonb,
  output jsonb,
  ok boolean NOT NULL DEFAULT true,
  at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  tool text NOT NULL,
  input jsonb NOT NULL,
  input_hash text NOT NULL,
  tainted boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'executed')),
  decided_by text,
  decided_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX approvals_pending_idx ON approvals (status, expires_at);

CREATE TABLE notes (
  id bigserial PRIMARY KEY,
  run_id uuid REFERENCES runs(id) ON DELETE SET NULL,
  title text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Append-only, hash-chained: each row's hash covers the previous row's hash.
CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL,
  actor text NOT NULL,
  event text NOT NULL,
  run_id uuid,
  detail jsonb NOT NULL DEFAULT '{}',
  prev_hash text NOT NULL,
  hash text NOT NULL
);

CREATE FUNCTION audit_block_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$;
CREATE TRIGGER audit_no_update_delete BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_block_mutation();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION audit_block_mutation();
