-- Supabase's public roles (anon = anyone with the project's public key, authenticated = its logged-in
-- users) were given full rights on every table. Row-level security blocks them today, but if it were
-- ever turned off on one table, anyone could read password hashes and emails.
-- SecureTrade's server connects as "postgres", so the app itself is not affected.
-- Safe to run more than once. Run it in the Supabase SQL Editor.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;

-- Tables made later must not get those rights back automatically
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;
