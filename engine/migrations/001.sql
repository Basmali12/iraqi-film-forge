-- Run explicitly as the schema owner, never automatically at server startup.
BEGIN;
SELECT pg_advisory_xact_lock(190163,2);
CREATE TABLE IF NOT EXISTS iff_migrations(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS iff_records(
 sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 kind text NOT NULL, id text NOT NULL, data jsonb NOT NULL,
 PRIMARY KEY(kind,id), CHECK(jsonb_typeof(data)='object'), CHECK(data->>'id'=id)
);
CREATE TABLE IF NOT EXISTS iff_sessions(token text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS iff_intents(key text PRIMARY KEY, job text NOT NULL);
CREATE TABLE IF NOT EXISTS iff_audit(id text PRIMARY KEY,at bigint NOT NULL,action text NOT NULL,subject text NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS iff_one_live_gpu ON iff_records((1))
 WHERE kind='job' AND data->>'action' IN ('start','generate') AND data->>'attachedEngineId' IS NULL
 AND data->>'status' IN ('queued','running','ready','stopping','uncertain','recovery_required')
 AND COALESCE(data->>'cloudStopped','false')!='true';
CREATE UNIQUE INDEX IF NOT EXISTS iff_unique_workspace ON iff_records((data->>'workspace')) WHERE kind='account';
INSERT INTO iff_migrations(version) VALUES('001') ON CONFLICT DO NOTHING;
COMMIT;
