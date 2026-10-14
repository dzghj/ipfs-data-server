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

-- Defensive: if "Plan" already existed from an earlier dev sequelize.sync()
-- run (so CREATE TABLE IF NOT EXISTS above was a no-op), its id column may
-- have no auto-increment default at all, making the INSERT below fail with
-- "null value in column id violates not-null constraint". This attaches one
-- if missing — safe to run every boot, whether or not it was already there.
CREATE SEQUENCE IF NOT EXISTS public."Plan_id_seq" OWNED BY public."Plan".id;
SELECT setval('public."Plan_id_seq"', COALESCE((SELECT MAX(id) FROM public."Plan"), 0) + 1, false);
ALTER TABLE public."Plan" ALTER COLUMN id SET DEFAULT nextval('public."Plan_id_seq"');

INSERT INTO public."Plan" (name, "maxFiles", price) VALUES
  ('Normal', 5, 0),
  ('Middle', 10, 9.99),
  ('Super', 999999, 19.99)
ON CONFLICT (name) DO NOTHING;
