-- ScholarTrack :: migration 012
-- Running the pipeline from the deployed app.
--
-- WHAT CHANGED AND WHY. Until now the crawlers ran only on a developer machine:
-- `/api/admin/pipeline` spawned a child process, which a serverless host cannot
-- do, and the scripts wrote with the service-role key, which must never be
-- deployed. That made the pipeline unrunnable from the deployed app.
--
-- Two things had to exist for it to run on Vercel:
--
--  1. **A job that survives a function call.** A crawl takes minutes; a
--     serverless function gets seconds. So a run becomes a ROW: the work to do,
--     how far through it is, and its log. A function processes as much as fits
--     in its budget, saves progress, and returns. Something calls it again.
--     A browser refresh, a redeploy, or a cold start loses nothing.
--
--  2. **A way to write without the service-role key.** The scripts bypass RLS
--     because they run as nobody. The app runs as SOMEBODY — a signed-in admin,
--     whose privileges are already defined here — so the deployed pipeline
--     writes through the same policies the review UI does. That keeps the
--     single most dangerous credential off the public host, which is the
--     promise docs/deployment.md has always made.
--
-- The staging tables were missing only their INSERT policies, because until now
-- nothing but the service role ever inserted into them.

-- ---------------------------------------------------------------------------
-- 1. Let an admin do what the scripts do
-- ---------------------------------------------------------------------------
-- SELECT and UPDATE already exist on these tables (migrations 003, 004, 011).
-- INSERT is what a running pipeline adds.

DROP POLICY IF EXISTS "Admins stage extractions" ON scholarship_extractions;
CREATE POLICY "Admins stage extractions"
    ON scholarship_extractions FOR INSERT
    TO authenticated
    WITH CHECK (is_admin());

DROP POLICY IF EXISTS "Admins stage candidates" ON scholarship_candidates;
CREATE POLICY "Admins stage candidates"
    ON scholarship_candidates FOR INSERT
    TO authenticated
    WITH CHECK (is_admin());

DROP POLICY IF EXISTS "Admins record sources" ON scholarship_sources;
CREATE POLICY "Admins record sources"
    ON scholarship_sources FOR INSERT
    TO authenticated
    WITH CHECK (is_admin());

-- ---------------------------------------------------------------------------
-- 2. The job
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pipeline_jobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    kind TEXT NOT NULL,

    -- The validated arguments, exactly as the whitelist in
    -- src/lib/pipeline/jobs.ts produced them. Stored so a run is reproducible
    -- and so the console can show what was actually asked for.
    args JSONB NOT NULL DEFAULT '{}'::jsonb,

    status TEXT NOT NULL DEFAULT 'queued',

    -- The work list, decided once when the job starts: programme ids for an
    -- extract, seed labels for a discover. Fixing it up front is what makes
    -- `cursor` meaningful across function calls — a list recomputed each tick
    -- could shift under the cursor and silently skip or repeat work.
    units JSONB NOT NULL DEFAULT '[]'::jsonb,
    cursor INT NOT NULL DEFAULT 0,
    -- Denormalised length of `units`, so the history list can show "12 of 20"
    -- without selecting the unit list of every past run.
    total INT NOT NULL DEFAULT 0,

    -- Rolling tallies, so the console can show progress without reading the log.
    staged INT NOT NULL DEFAULT 0,
    failed INT NOT NULL DEFAULT 0,
    skipped INT NOT NULL DEFAULT 0,

    error TEXT,
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    -- Touched by every tick. A job whose heartbeat has gone quiet was killed
    -- mid-flight — a function timeout, a deploy, a closed tab — and is
    -- reclaimable rather than stuck.
    heartbeat_at TIMESTAMPTZ
);

ALTER TABLE pipeline_jobs
    DROP CONSTRAINT IF EXISTS pipeline_jobs_kind_check;
ALTER TABLE pipeline_jobs
    ADD CONSTRAINT pipeline_jobs_kind_check
    CHECK (kind IN ('extract', 'discover'));

ALTER TABLE pipeline_jobs
    DROP CONSTRAINT IF EXISTS pipeline_jobs_status_check;
ALTER TABLE pipeline_jobs
    ADD CONSTRAINT pipeline_jobs_status_check
    CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled'));

-- One live job at a time, enforced by the database rather than by a variable in
-- one server process — which is exactly what broke on serverless, where every
-- request may land in a different instance. Two concurrent crawls would double
-- the request rate at the same funders and race through one free-tier quota.
--
-- The indexed expression is `true` for every row the predicate admits, so
-- uniqueness over it means "at most one such row". It is written against a
-- column rather than as a bare constant because an index expression may not be
-- constant.
CREATE UNIQUE INDEX IF NOT EXISTS pipeline_jobs_one_live
    ON pipeline_jobs ((status IN ('queued', 'running')))
    WHERE status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS pipeline_jobs_recent_idx
    ON pipeline_jobs (created_at DESC);

-- ---------------------------------------------------------------------------
-- 3. Its log
-- ---------------------------------------------------------------------------
-- A separate table rather than an array column: the console appends constantly
-- and reads incrementally ("everything after line 240"), and rewriting a
-- growing array on every tick is the wrong shape for both.
CREATE TABLE IF NOT EXISTS pipeline_job_lines (
    id BIGSERIAL PRIMARY KEY,
    job_id UUID NOT NULL REFERENCES pipeline_jobs(id) ON DELETE CASCADE,
    seq INT NOT NULL,
    line TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pipeline_job_lines_job_idx
    ON pipeline_job_lines (job_id, seq);

-- ---------------------------------------------------------------------------
-- 4. Who may run one
-- ---------------------------------------------------------------------------
ALTER TABLE pipeline_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_job_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins read jobs" ON pipeline_jobs;
CREATE POLICY "Admins read jobs"
    ON pipeline_jobs FOR SELECT
    TO authenticated
    USING (is_admin());

DROP POLICY IF EXISTS "Admins start jobs" ON pipeline_jobs;
CREATE POLICY "Admins start jobs"
    ON pipeline_jobs FOR INSERT
    TO authenticated
    WITH CHECK (is_admin());

DROP POLICY IF EXISTS "Admins drive jobs" ON pipeline_jobs;
CREATE POLICY "Admins drive jobs"
    ON pipeline_jobs FOR UPDATE
    TO authenticated
    USING (is_admin())
    WITH CHECK (is_admin());

DROP POLICY IF EXISTS "Admins delete jobs" ON pipeline_jobs;
CREATE POLICY "Admins delete jobs"
    ON pipeline_jobs FOR DELETE
    TO authenticated
    USING (is_admin());

DROP POLICY IF EXISTS "Admins read job lines" ON pipeline_job_lines;
CREATE POLICY "Admins read job lines"
    ON pipeline_job_lines FOR SELECT
    TO authenticated
    USING (is_admin());

DROP POLICY IF EXISTS "Admins write job lines" ON pipeline_job_lines;
CREATE POLICY "Admins write job lines"
    ON pipeline_job_lines FOR INSERT
    TO authenticated
    WITH CHECK (is_admin());

-- ---------------------------------------------------------------------------
-- 5. Claim the next tick
-- ---------------------------------------------------------------------------
-- Moves a job to `running` and stamps the heartbeat, but ONLY if nothing else
-- is already working on it. Two browser tabs pointed at the same job would
-- otherwise both process unit 7, crawl the same site twice and stage the same
-- proposal twice.
--
-- `stale_after` is what stops that guard becoming a deadlock: a function that
-- was killed mid-tick never got to release the job, and without a reclaim
-- window the run would be stuck forever with nobody running it.
CREATE OR REPLACE FUNCTION claim_pipeline_tick(
    job UUID,
    stale_after INTERVAL DEFAULT INTERVAL '5 minutes'
)
RETURNS pipeline_jobs
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    claimed pipeline_jobs;
BEGIN
    UPDATE pipeline_jobs SET
        status       = 'running',
        started_at   = COALESCE(started_at, NOW()),
        heartbeat_at = NOW()
    WHERE id = job
      AND status IN ('queued', 'running')
      AND (
            status = 'queued'
            OR heartbeat_at IS NULL
            OR heartbeat_at < NOW() - stale_after
          )
    RETURNING * INTO claimed;

    RETURN claimed;
END;
$$;

COMMENT ON FUNCTION claim_pipeline_tick(UUID, INTERVAL) IS
    'Claims a job for one tick. Returns NULL when another worker holds it and its heartbeat is still fresh.';

-- No view over these tables on purpose. A view is owned by whoever created it
-- and, unless it opts into `security_invoker`, reads the underlying table with
-- the OWNER's rights — which would hand every authenticated visitor the run
-- history that the policies above just restricted to admins. The app selects
-- from the table directly, under RLS, and `total` exists so that costs nothing.
