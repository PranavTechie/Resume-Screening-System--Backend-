/**
 * End-to-end API smoke test against a running backend (real Gemini unless AI_MOCK_MODE on the server).
 *   API_URL=http://localhost:3000 npx tsx scripts/apiSmoke.ts
 * Covers: login, single upload, non-resume rejected without charge, bulk upload of 5 (incl. 1 junk + 1 duplicate),
 * ranking a job, CSV export, credit balance == ledger.
 */
import { api, fakeResume, JUNK_TEXT, ledgerCheck, SAMPLE_JD, testUserSession, topUpTestCredits, waitForBatch } from './lib';

const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, info = '') => {
  results.push([name, ok, info]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`);
};

const txt = (name: string, text: string) => new File([text], name, { type: 'text/plain' });

async function main() {
  const email = process.env.SMOKE_EMAIL || 'rss.smoke.test@example.com';
  const { userId, token } = await testUserSession(email);
  check('login (test user)', Boolean(token));
  const health = await fetch(`${process.env.API_URL || 'http://localhost:3000'}/health`).then((r) => r.json());
  check('/health reports queue', health?.queue !== undefined && health?.worker?.running === true, JSON.stringify(health.queue));

  const start = await api(token, 'GET', '/api/credits/balance');
  if ((start.data?.credits ?? 0) < 12) await topUpTestCredits(userId, 12);
  const bal0 = (await api(token, 'GET', '/api/credits/balance')).data.credits;

  // 1. Single upload (unique text so it's never a duplicate of an earlier run)
  const single = fakeResume(Date.now() % 1000);
  const fd1 = new FormData();
  fd1.append('file', txt('single_resume.txt', `${single.text}\nRun ${Date.now()}`));
  const up = await api(token, 'POST', '/api/resumes', fd1);
  const bal1 = (await api(token, 'GET', '/api/credits/balance')).data.credits;
  check('single upload analyzed', up.status === 201 && Boolean(up.data?.resume?.id), `status ${up.status} ${up.json?.error?.code || ''}`);
  check('single upload charged exactly 1', bal1 === bal0 - 1, `${bal0} -> ${bal1}`);

  // 2. Non-resume rejected without charge
  const fd2 = new FormData();
  fd2.append('file', txt('invoice.txt', `${JUNK_TEXT}\n${Date.now()}`));
  const junk = await api(token, 'POST', '/api/resumes', fd2);
  const bal2 = (await api(token, 'GET', '/api/credits/balance')).data.credits;
  check('non-resume rejected', junk.status === 422 && ['NOT_A_RESUME', 'TOO_LITTLE_TEXT'].includes(junk.json?.error?.code), `${junk.status} ${junk.json?.error?.code}: ${junk.json?.error?.message}`);
  check('non-resume not charged', bal2 === bal1, `${bal1} -> ${bal2}`);

  // 3. Same file again = duplicate, free
  const fd3 = new FormData();
  fd3.append('file', txt('single_resume.txt', `${single.text}\nRun dup`));
  await api(token, 'POST', '/api/resumes', fd3); // first time (charged)
  const balBeforeDup = (await api(token, 'GET', '/api/credits/balance')).data.credits;
  const fd3b = new FormData();
  fd3b.append('file', txt('single_resume_copy.txt', `${single.text}\nRun dup`));
  const dup = await api(token, 'POST', '/api/resumes', fd3b);
  const balAfterDup = (await api(token, 'GET', '/api/credits/balance')).data.credits;
  check('single duplicate refused for free', dup.status === 409 && balAfterDup === balBeforeDup, `${dup.status} ${dup.json?.error?.code}`);

  // 4. Bulk: 3 resumes + 1 junk + 1 duplicate (same bytes as #1 in this batch)
  const runTag = Date.now();
  const fd4 = new FormData();
  fd4.append('consent', 'true');
  const r1 = `${fakeResume(1).text}\n${runTag}`;
  fd4.append('files', txt('bulk_1.txt', r1));
  fd4.append('files', txt('bulk_2.txt', `${fakeResume(2).text}\n${runTag}`));
  fd4.append('files', txt('bulk_3.txt', `${fakeResume(3).text}\n${runTag}`));
  fd4.append('files', txt('bulk_junk.txt', `${JUNK_TEXT}\n${runTag}`));
  fd4.append('files', txt('bulk_1_copy.txt', r1));
  const balBeforeBulk = (await api(token, 'GET', '/api/credits/balance')).data.credits;
  const bulk = await api(token, 'POST', '/api/batches/upload', fd4);
  check('bulk upload accepted (202)', bulk.status === 202, `${bulk.status} ${bulk.json?.error?.code || ''}`);
  check('bulk reserved 4 credits (duplicate free up front)', bulk.data?.creditsReserved === 4, String(bulk.data?.creditsReserved));
  const done = await waitForBatch(token, bulk.data.batch.id);
  const c = done.counts || {};
  check('bulk: 3 done, 1 rejected, 1 duplicate', c.done === 3 && c.rejected === 1 && c.duplicate === 1, JSON.stringify(c));
  const balAfterBulk = (await api(token, 'GET', '/api/credits/balance')).data.credits;
  check('bulk: net charge 3 (junk refunded)', balAfterBulk === balBeforeBulk - 3, `${balBeforeBulk} -> ${balAfterBulk}, refunded ${done.creditsRefunded}`);
  const dupItem = (done.items || []).find((i: any) => i.status === 'duplicate');
  check('duplicate shows "Duplicate of"', Boolean(dupItem?.errorMessage?.startsWith('Duplicate of')), dupItem?.errorMessage);

  // 5. Rank a job
  const job = await api(token, 'POST', '/api/jobs', { title: 'Frontend Developer (smoke test)', description: SAMPLE_JD });
  const resumeIds = (done.items || []).filter((i: any) => i.status === 'done').map((i: any) => i.resultRef);
  await api(token, 'POST', `/api/jobs/${job.data.id}/attach`, { resumeIds });
  const balBeforeRank = (await api(token, 'GET', '/api/credits/balance')).data.credits;
  const rank = await api(token, 'POST', `/api/jobs/${job.data.id}/rank`);
  check('rank returns 202 + batch', rank.status === 202 && Boolean(rank.data?.batch?.id), `${rank.status} ${rank.json?.error?.code || ''}`);
  const ranked = await waitForBatch(token, rank.data.batch.id);
  check('rank: all candidates done', (ranked.counts?.done || 0) === resumeIds.length, JSON.stringify(ranked.counts));
  const balAfterRank = (await api(token, 'GET', '/api/credits/balance')).data.credits;
  check('rank charged 1 per candidate', balAfterRank === balBeforeRank - resumeIds.length, `${balBeforeRank} -> ${balAfterRank}`);
  const jobAfter = await api(token, 'GET', `/api/jobs/${job.data.id}`);
  const matches = Object.values(jobAfter.data?.matches || {}) as any[];
  check('matches have scoring_version + reason', matches.length > 0 && matches.every((m) => m.scoringVersion && m.matchReason), matches.map((m) => m.matchPercentage).join(','));

  // 6. Candidate status + CSV export
  const st = await api(token, 'PATCH', `/api/jobs/${job.data.id}/candidates/status`, { resumeIds: resumeIds.slice(0, 1), status: 'shortlisted' });
  check('candidate status update', st.data?.updated === 1);
  const csvRes = await fetch(`${process.env.API_URL || 'http://localhost:3000'}/api/jobs/${job.data.id}/export.csv`, { headers: { Authorization: `Bearer ${token}` } });
  const csv = await csvRes.text();
  check('CSV export', csvRes.status === 200 && csv.includes('Match %') && csv.split('\r\n').length >= resumeIds.length + 1, `${csv.length} bytes`);

  // 7. Ledger
  const led = await ledgerCheck(userId);
  check('credit balance == ledger', led.ok, `credits ${led.credits}, ledger ${led.ledger}`);

  const failed = results.filter((r) => !r[1]);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('Smoke test crashed:', e.message);
  process.exit(1);
});
