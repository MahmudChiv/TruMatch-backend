import { PrismaClient } from '@prisma/client';

const dbUrl = process.env.DIRECT_URL || process.env.DATABASE_URL;
const prisma = new PrismaClient({
  datasources: dbUrl ? { db: { url: dbUrl } } : undefined,
});

export async function cleanTestMatchingData() {
  console.log('Cleaning up test matching data...');

  const USER_PREFIX = 'test-matching-user-';
  const HACKATHON_TITLE_PREFIX = 'TruMatch AI Matching Test';

  // 1. Delete test hackathons (cascades to joins, teams, invites)
  const deletedHackathons = await prisma.hackathon.deleteMany({
    where: {
      title: {
        startsWith: HACKATHON_TITLE_PREFIX,
      },
    },
  });
  console.log(`Deleted ${deletedHackathons.count} test hackathon(s).`);

  // 2. Delete test users (cascades to metrics, sessions, commitment scores, etc.)
  const deletedUsers = await prisma.user.deleteMany({
    where: {
      username: {
        startsWith: USER_PREFIX,
      },
    },
  });
  console.log(`Deleted ${deletedUsers.count} test user(s).`);
}

if (require.main === module) {
  cleanTestMatchingData()
    .then(async () => {
      await prisma.$disconnect();
      console.log('Cleanup finished successfully.');
    })
    .catch(async (e) => {
      console.error('Error during cleanup:', e);
      await prisma.$disconnect();
      process.exit(1);
    });
}
