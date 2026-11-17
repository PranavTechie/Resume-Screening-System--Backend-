import { jobService } from '../services/job.service';
import { env } from '../config/env';

async function run() {
  const userId = 'd40f1a1f-62e0-4813-9283-dc22505da87b';
  const jobId = '757d3956-ff20-482d-98d3-10d038367da3';

  console.log(`Testing rankResumesForJob...`);
  try {
    const result = await jobService.rankResumesForJob(userId, jobId);
    console.log('Result successfully returned!');
    console.log('Job status:', result.job.status);
    console.log('Job isRanked:', result.job.isRanked);
    console.log('Matches length:', Object.keys(result.job.matches || {}).length);
    for (const [key, match] of Object.entries(result.job.matches || {})) {
       console.log(`Resume ${key}:`, match.skillsMatchedCount);
    }
  } catch (err: any) {
    console.error('Failed ranking:', err);
  }
}

run();
