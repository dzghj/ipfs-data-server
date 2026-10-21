-- Gates /api/admin/* routes (auth.js's requireAdmin middleware). Previously
-- the /admin frontend page called an endpoint that didn't exist at all and
-- had no role concept to check even if it had — this is what that route
-- now checks. No UI to manage this yet; flip it directly:
--   UPDATE "Users" SET "isAdmin" = true WHERE email = '...';
-- Mirrored in db.js's BOOTSTRAP_SQL — keep both in sync.
ALTER TABLE public."Users" ADD COLUMN IF NOT EXISTS "isAdmin" BOOLEAN NOT NULL DEFAULT false;
