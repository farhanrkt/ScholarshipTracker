-- ScholarTrack :: migration 003
-- Admin review, enforced by the database rather than by page code.
--
-- The review UI must read `scholarship_extractions`, which is deny-all. The
-- tempting shortcut is to give the web app the service-role key. Don't: that key
-- bypasses EVERY policy, and one accidental import from a client component
-- would ship it to the browser.
--
-- Instead an allowlist table drives RLS. The app keeps using the anon key, the
-- rules live in Postgres, and "who may review" is data you can change with an
-- INSERT rather than a redeploy.

CREATE TABLE IF NOT EXISTS admins (
    email TEXT PRIMARY KEY,
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE admins ENABLE ROW LEVEL SECURITY;

-- An admin may see the allowlist. Nobody else can read it at all, so the list
-- of privileged addresses is not an anonymous-readable target.
DROP POLICY IF EXISTS "Admins read the allowlist" ON admins;
CREATE POLICY "Admins read the allowlist"
    ON admins FOR SELECT
    TO authenticated
    USING (LOWER(email) = LOWER(auth.jwt() ->> 'email'));

-- --------------------------------------------------------------------------
-- Is the caller an admin?
--
-- SECURITY DEFINER so it can consult `admins` regardless of the caller's own
-- policies, with an empty search_path so a caller cannot shadow the table with
-- one of their own. Anonymous sessions carry no email claim, so they are out.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.admins
        WHERE LOWER(email) = LOWER(auth.jwt() ->> 'email')
    );
$$;

-- --------------------------------------------------------------------------
-- Review access
-- --------------------------------------------------------------------------
DROP POLICY IF EXISTS "Admins read extractions" ON scholarship_extractions;
CREATE POLICY "Admins read extractions"
    ON scholarship_extractions FOR SELECT
    TO authenticated
    USING (is_admin());

DROP POLICY IF EXISTS "Admins resolve extractions" ON scholarship_extractions;
CREATE POLICY "Admins resolve extractions"
    ON scholarship_extractions FOR UPDATE
    TO authenticated
    USING (is_admin())
    WITH CHECK (is_admin());

-- apply_extraction() is SECURITY INVOKER, so promoting a row needs the caller
-- to hold an UPDATE policy on `scholarships` as well. Only admins get one --
-- everyone else still cannot write to the table at all.
DROP POLICY IF EXISTS "Admins update scholarships" ON scholarships;
CREATE POLICY "Admins update scholarships"
    ON scholarships FOR UPDATE
    TO authenticated
    USING (is_admin())
    WITH CHECK (is_admin());

-- --------------------------------------------------------------------------
-- Add yourself
-- --------------------------------------------------------------------------
-- Replace with the address you linked in the app, then sign in with it.
-- INSERT INTO admins (email, note) VALUES ('you@example.com', 'founder');
