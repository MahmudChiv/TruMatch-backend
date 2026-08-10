import { PrismaClient, GithubConfidence } from '@prisma/client';
import { cleanTestMatchingData } from './clean-test-matching';

const dbUrl = process.env.DIRECT_URL || process.env.DATABASE_URL;
const prisma = new PrismaClient({
  datasources: dbUrl ? { db: { url: dbUrl } } : undefined,
});

interface SeedProfile {
  username: string;
  githubId: string;
  name: string;
  email: string;
  avatarUrl: string;
  bio: string;
  roleTags: string[];
  primaryStack: string;
  githubScore: number;
  githubConfidence: GithubConfidence;
  qualifyingRepoCount: number;
  totalCommitCount: number;
  interviewScore: number;
  declaredHoursPerDay: number;
  bioSummary: string;
  githubWeight: number;
  interviewWeight: number;
}

const TEST_PROFILES: SeedProfile[] = [
  {
    username: 'test-matching-user-1',
    githubId: 'test-matching-ghid-1',
    name: 'Alex Chen',
    email: 'alex.chen@test-matching.fake',
    avatarUrl: 'https://avatars.githubusercontent.com/u/fake-test-1',
    bio: 'Senior backend engineer passionate about distributed systems and clean APIs.',
    roleTags: ['Backend', 'DevOps'],
    primaryStack: 'Node.js, NestJS, PostgreSQL, Docker',
    githubScore: 85.0,
    githubConfidence: GithubConfidence.high,
    qualifyingRepoCount: 14,
    totalCommitCount: 420,
    interviewScore: 90.0,
    declaredHoursPerDay: 8.0,
    bioSummary: 'Experienced backend architecture lead with 8 hours daily availability and high commit consistency.',
    githubWeight: 0.7,
    interviewWeight: 0.3,
  },
  {
    username: 'test-matching-user-2',
    githubId: 'test-matching-ghid-2',
    name: 'Sarah Lin',
    email: 'sarah.lin@test-matching.fake',
    avatarUrl: 'https://avatars.githubusercontent.com/u/fake-test-2',
    bio: 'Frontend specialist crafting sleek user interfaces and intuitive UX flows.',
    roleTags: ['Frontend', 'Design/UI'],
    primaryStack: 'React, Next.js, Tailwind CSS, TypeScript',
    githubScore: 75.0,
    githubConfidence: GithubConfidence.high,
    qualifyingRepoCount: 9,
    totalCommitCount: 280,
    interviewScore: 80.0,
    declaredHoursPerDay: 6.0,
    bioSummary: 'UI/UX frontend developer capable of delivering rapid, polished web components with 6 hrs/day focus.',
    githubWeight: 0.7,
    interviewWeight: 0.3,
  },
  {
    username: 'test-matching-user-3',
    githubId: 'test-matching-ghid-3',
    name: 'Michael Vance',
    email: 'michael.vance@test-matching.fake',
    avatarUrl: 'https://avatars.githubusercontent.com/u/fake-test-3',
    bio: 'AI researcher integrating LLMs, agentic workflows, and vector databases.',
    roleTags: ['AI/ML', 'Backend'],
    primaryStack: 'Python, PyTorch, Gemini API, FastAPI',
    githubScore: 45.0,
    githubConfidence: GithubConfidence.low,
    qualifyingRepoCount: 3,
    totalCommitCount: 95,
    interviewScore: 88.0,
    declaredHoursPerDay: 7.0,
    bioSummary: 'AI/ML specialist with low GitHub activity history but detailed interview responses and strong LLM expertise.',
    githubWeight: 0.4,
    interviewWeight: 0.6,
  },
  {
    username: 'test-matching-user-4',
    githubId: 'test-matching-ghid-4',
    name: 'Jordan Taylor',
    email: 'jordan.taylor@test-matching.fake',
    avatarUrl: 'https://avatars.githubusercontent.com/u/fake-test-4',
    bio: 'Product strategist and designer focusing on hackathon team alignment and user research.',
    roleTags: ['Product/PM', 'Design/UI'],
    primaryStack: 'Figma, Product Strategy, Agile, Wireframing',
    githubScore: 20.0,
    githubConfidence: GithubConfidence.insufficient,
    qualifyingRepoCount: 1,
    totalCommitCount: 15,
    interviewScore: 92.0,
    declaredHoursPerDay: 4.0,
    bioSummary: 'Non-technical product lead with minimal GitHub history but exceptional interview communication and task breakdown.',
    githubWeight: 0.1,
    interviewWeight: 0.9,
  },
  {
    username: 'test-matching-user-5',
    githubId: 'test-matching-ghid-5',
    name: 'David Kim',
    email: 'david.kim@test-matching.fake',
    avatarUrl: 'https://avatars.githubusercontent.com/u/fake-test-5',
    bio: 'Fullstack developer exploring new frameworks during hackathons.',
    roleTags: ['Frontend', 'Backend'],
    primaryStack: 'Vue.js, Express.js, MongoDB',
    githubScore: 48.0,
    githubConfidence: GithubConfidence.low,
    qualifyingRepoCount: 4,
    totalCommitCount: 110,
    interviewScore: 50.0,
    declaredHoursPerDay: 3.0,
    bioSummary: 'Part-time participant with moderate availability (3 hrs/day) and average commitment indicators.',
    githubWeight: 0.4,
    interviewWeight: 0.6,
  },
  {
    username: 'test-matching-user-6',
    githubId: 'test-matching-ghid-6',
    name: 'Elena Rostova',
    email: 'elena.rostova@test-matching.fake',
    avatarUrl: 'https://avatars.githubusercontent.com/u/fake-test-6',
    bio: 'Junior developer looking to gain hackathon team experience.',
    roleTags: ['Backend'],
    primaryStack: 'Python, Flask',
    githubScore: 25.0,
    githubConfidence: GithubConfidence.insufficient,
    qualifyingRepoCount: 1,
    totalCommitCount: 22,
    interviewScore: 30.0,
    declaredHoursPerDay: 2.0,
    bioSummary: 'Beginner programmer with low availability (2 hrs/day) and limited past experience.',
    githubWeight: 0.1,
    interviewWeight: 0.9,
  },
];

interface CreatedUser {
  id: string;
  username: string;
  name: string | null;
  roleTags: string[];
  primaryStack: string | null;
  commitmentScore: number;
  githubConfidence: GithubConfidence;
  declaredHoursPerDay: number;
}

export async function seedTestMatchingData() {
  console.log('--- Resetting existing test matching data ---');
  await cleanTestMatchingData();

  console.log('\n--- Seeding fake users & scores ---');
  const createdUsers: CreatedUser[] = [];

  for (const profile of TEST_PROFILES) {
    const compositeScore = Number(
      (profile.githubScore * profile.githubWeight + profile.interviewScore * profile.interviewWeight).toFixed(1)
    );

    // Create User along with relations in a single nested create query
    const user = await prisma.user.create({
      data: {
        username: profile.username,
        githubId: profile.githubId,
        name: profile.name,
        email: profile.email,
        avatarUrl: profile.avatarUrl,
        bio: profile.bio,
        roleTags: profile.roleTags,
        primaryStack: profile.primaryStack,
        commitmentScore: compositeScore,
        githubMetrics: {
          create: {
            status: 'complete',
            githubConsistencyScore: profile.githubScore,
            githubConfidence: profile.githubConfidence,
            qualifyingRepoCount: profile.qualifyingRepoCount,
            totalCommitCount: profile.totalCommitCount,
          },
        },
        interviewSession: {
          create: {
            status: 'complete',
            transcriptJson: [],
            structuredOutput: {
              specificityScore: profile.interviewScore,
              clarity: 'high',
            },
            bioSummary: profile.bioSummary,
          },
        },
        commitmentScore_rel: {
          create: {
            githubScore: profile.githubScore,
            interviewScore: profile.interviewScore,
            commitmentScore: compositeScore,
            appliedGithubWeight: profile.githubWeight,
            appliedInterviewWeight: profile.interviewWeight,
            declaredHoursPerDay: profile.declaredHoursPerDay,
            scoreExplanationSummary: `Seeded test composite score: ${profile.githubWeight * 100}% GH (${profile.githubScore}) + ${profile.interviewWeight * 100}% Interview (${profile.interviewScore}).`,
          },
        },
      },
    });

    createdUsers.push({
      id: user.id,
      username: user.username,
      name: user.name,
      roleTags: user.roleTags,
      primaryStack: user.primaryStack,
      commitmentScore: compositeScore,
      githubConfidence: profile.githubConfidence,
      declaredHoursPerDay: profile.declaredHoursPerDay,
    });
  }

  console.log(`Created ${createdUsers.length} fake users with full metrics & scores.`);

  // Create fake test hackathon
  console.log('\n--- Creating fake test hackathon ---');
  const hackathon = await prisma.hackathon.create({
    data: {
      title: 'TruMatch AI Matching Test Hackathon 2026',
      shortDescription: 'A test hackathon for manually validating AI team matching & charter generation.',
      venueType: 'virtual',
      status: 'verified',
      submittedBy: createdUsers[0].id,
      teamSize: '4 members',
    },
  });

  // Link all fake users to the hackathon using createMany
  console.log('--- Linking all fake users to test hackathon ---');
  await prisma.hackathonJoin.createMany({
    data: createdUsers.map((u) => ({
      hackathonId: hackathon.id,
      userId: u.id,
    })),
  });

  console.log('\n================ SEEDED TEST USERS SUMMARY TABLE ================');
  console.table(
    createdUsers.map((u) => ({
      'User ID': u.id,
      'Username': u.username,
      'Name': u.name,
      'Role Tags': u.roleTags.join(', '),
      'Primary Stack': u.primaryStack,
      'Composite Score': u.commitmentScore.toFixed(1),
      'GH Confidence': u.githubConfidence,
      'Hours/Day': u.declaredHoursPerDay,
    }))
  );

  console.log('==================================================================');
  console.log(`\n✅ TEST HACKATHON ID: ${hackathon.id}`);
  console.log(`Use this Hackathon ID to test POST /matching/recommendations or service methods.\n`);
}

if (require.main === module) {
  seedTestMatchingData()
    .then(async () => {
      await prisma.$disconnect();
    })
    .catch(async (e) => {
      console.error('Error during seeding:', e);
      await prisma.$disconnect();
      process.exit(1);
    });
}
