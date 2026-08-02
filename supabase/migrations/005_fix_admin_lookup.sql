-- ScholarTrack :: migration 005
-- Fix: is_admin() trusted a stale JWT claim.
--
-- THE BUG: the previous version compared against `auth.jwt() ->> 'email'`. An
-- access token is issued once and carries whatever claims were true at that
-- moment. A visitor who starts anonymous (no email claim) and later links an
-- address keeps the OLD token until it refreshes — so `auth.jwt() ->> 'email'`
-- stays NULL for up to an hour after a perfectly successful confirmation, and
-- every admin check fails for reasons nothing in the UI can explain.
--
-- THE FIX: resolve the email from auth.users via auth.uid(). The user id in the
-- token is stable and correct from the moment the session exists, so this reads
-- the current address rather than a snapshot of an old one.

CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM auth.users u
        JOIN public.admins a ON LOWER(a.email) = LOWER(u.email)
        WHERE u.id = auth.uid()
          -- An unconfirmed address must not grant access: anyone could type
          -- an admin's address into the link form and wait.
          AND u.email_confirmed_at IS NOT NULL
    );
$$;

-- The allowlist policy had the same stale-claim problem.
DROP POLICY IF EXISTS "Admins read the allowlist" ON admins;
CREATE POLICY "Admins read the allowlist"
    ON admins FOR SELECT
    TO authenticated
    USING (is_admin());

-- --------------------------------------------------------------------------
-- Diagnostic: why am I not an admin?
-- --------------------------------------------------------------------------
-- Returns one row explaining the current session's standing. Run it while
-- signed in (from the app, not the SQL editor -- the editor has no user).
CREATE OR REPLACE FUNCTION why_not_admin()
RETURNS TABLE (
    user_id UUID,
    email TEXT,
    email_confirmed BOOLEAN,
    on_allowlist BOOLEAN,
    verdict TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT
        u.id,
        u.email::TEXT,
        u.email_confirmed_at IS NOT NULL,
        EXISTS (SELECT 1 FROM public.admins a WHERE LOWER(a.email) = LOWER(u.email)),
        CASE
            WHEN u.email IS NULL THEN 'No email on this account — link one from the dashboard banner.'
            WHEN u.email_confirmed_at IS NULL THEN 'Email attached but not confirmed — open the link in your inbox.'
            WHEN NOT EXISTS (SELECT 1 FROM public.admins a WHERE LOWER(a.email) = LOWER(u.email))
                THEN 'Confirmed, but this address is not in the admins table.'
            ELSE 'You are an admin.'
        END
    FROM auth.users u
    WHERE u.id = auth.uid();
$$;
