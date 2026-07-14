CREATE TABLE IF NOT EXISTS public."NomineeAccessSends" (
  id SERIAL PRIMARY KEY,
  "nomineeId" INTEGER NOT NULL,
  "sentAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "sendCount" INTEGER NOT NULL DEFAULT 0,
  token TEXT,
  "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nominee_access_sends_nominee_id
  ON public."NomineeAccessSends" ("nomineeId");

CREATE INDEX IF NOT EXISTS idx_nominee_access_sends_send_count
  ON public."NomineeAccessSends" ("sendCount", "sentAt");
