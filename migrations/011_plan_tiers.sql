-- User tier system: every user has a Plan (via User.planId, defaulting to
-- none == "Normal" at the column-default maxFileNumber of 5) that caps how
-- many files they can keep in any single folder/category — not an
-- account-wide total. See index.js's /api/upload (the actual enforcement)
-- and resolveUserPlan().
--
-- The Plan table previously only existed via sequelize.sync(), which is
-- skipped in production — so in any deployed environment it likely never
-- existed at all, and /api/upgrade/options and /api/upgrade/subscribe would
-- have errored against a missing table. This creates it for real and seeds
-- the three tiers:
--   Normal  —  5 files per folder (the default for new accounts)
--   Middle  — 10 files per folder
--   Super   — effectively unlimited (999999 is a sentinel, not a real cap;
--             see UNLIMITED_FILES in index.js)
--
-- ON CONFLICT (name) DO NOTHING — safe to run on every boot, and won't
-- clobber rows that already exist (e.g. from a dev sequelize.sync() with
-- different values someone tweaked by hand).

CREATE TABLE IF NOT EXISTS public."Plan" (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  "maxFiles"  INTEGER NOT NULL,
  price       DOUBLE PRECISION NOT NULL,
  "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

INSERT INTO public."Plan" (name, "maxFiles", price) VALUES
  ('Normal', 5, 0),
  ('Middle', 10, 9.99),
  ('Super', 999999, 19.99)
ON CONFLICT (name) DO NOTHING;
