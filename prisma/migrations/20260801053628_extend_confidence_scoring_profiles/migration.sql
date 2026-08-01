-- CreateEnum
CREATE TYPE "GithubConfidence" AS ENUM ('high', 'low', 'insufficient');

-- AlterTable
ALTER TABLE "commitment_scores" ADD COLUMN     "appliedGithubWeight" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
ADD COLUMN     "appliedInterviewWeight" DOUBLE PRECISION NOT NULL DEFAULT 0.3,
ADD COLUMN     "cappedDiscrepancyAdjustments" JSONB,
ADD COLUMN     "discrepancyResolutionPattern" DOUBLE PRECISION,
ADD COLUMN     "scoreExplanationSummary" TEXT;

-- AlterTable
ALTER TABLE "github_metrics" ADD COLUMN     "accountCreatedAt" TIMESTAMP(3),
ADD COLUMN     "githubConfidence" "GithubConfidence" NOT NULL DEFAULT 'insufficient',
ADD COLUMN     "qualifyingRepoCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "totalCommitCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "interview_sessions" ADD COLUMN     "bioSummary" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "contextNote" TEXT;
