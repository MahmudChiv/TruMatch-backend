-- Add interview_sessions table
CREATE TABLE IF NOT EXISTS "interview_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'in_progress',
    "transcriptJson" JSONB NOT NULL DEFAULT '[]',
    "structuredOutput" JSONB,
    "errorReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "interview_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "interview_sessions_userId_key" ON "interview_sessions"("userId");

ALTER TABLE "interview_sessions"
  DROP CONSTRAINT IF EXISTS "interview_sessions_userId_fkey";
ALTER TABLE "interview_sessions"
  ADD CONSTRAINT "interview_sessions_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Add commitment_scores table
CREATE TABLE IF NOT EXISTS "commitment_scores" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "githubScore" DOUBLE PRECISION NOT NULL,
    "interviewScore" DOUBLE PRECISION NOT NULL,
    "commitmentScore" DOUBLE PRECISION NOT NULL,
    "declaredHoursPerDay" DOUBLE PRECISION,
    "flaggedDiscrepancies" JSONB,
    "communicationNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "commitment_scores_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "commitment_scores_userId_key" ON "commitment_scores"("userId");

ALTER TABLE "commitment_scores"
  DROP CONSTRAINT IF EXISTS "commitment_scores_userId_fkey";
ALTER TABLE "commitment_scores"
  ADD CONSTRAINT "commitment_scores_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
