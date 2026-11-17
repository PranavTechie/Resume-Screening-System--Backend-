/**
 * Load sanity check: one batch of 60 generated fake resumes (2 batches: 50 + 10, the per-batch max is 50).
 * Run the backend with AI_MOCK_MODE=true (non-production only) so this tests the queue, not Gemini quota:
 *   AI_MOCK_MODE=true PORT=3005 npm run dev          (in another terminal)
 *   CONFIRM_LIVE_TEST=yes API_URL=http://localhost:3005 npm run load:test
 * Confirms: every item reaches a final state, credits == ledger, /health stays fast while processing.
 * Still hits the single live Supabase project for its DB rows even in mock mode — the test account
 * it creates is deleted automatically when the script exits, pass or fail.
 */
import { api, cleanupTestUser, fakeResume, ledgerCheck, testUserSession, topUpTestCredits, waitForBatch, API } from './lib';

async function main() {
  const email = process.env.LOAD_EMAIL || 'rss.load.test@example.com';
  try {
    return await runLoad(email);
  } finally {
    await cleanupTestUser(email);
  }
}

async function runLoad(email: string) {
  const total = Number(process.env.LOAD_COUNT || 60);
  const { userId, token } = await testUserSession(email);
  const bal = (await api(token, 'GET', '/api/credits/balance')).data?.credits ?? 0;
  if (bal < total) await topUpTestCredits(userId, total - bal + 5);
  const before = await ledgerCheck(userId);
  console.log(`credits before: ${before.credits} (ledger ${before.ledger})`);

  const tag = Date.now();
  const files = Array.from({ length: total }, (_, i) => new File([`${fakeResume(i).text}\nload-run ${tag}`], `load_${String(i).padStart(2, '0')}.txt`, { type: 'text/plain' }));
  const chunks: File[][] = [];
  for (let i = 0; i < files.length; i += 50) chunks.push(files.slice(i, i + 50));

  const t0 = Date.now();
  const batchIds: string[] = [];
  for (const chunk of chunks) {
    const fd = new FormData();
    fd.append('consent', 'true');
    chunk.forEach((f) => fd.append('files', f));
    const res = await api(token, 'POST', '/api/batches/upload', fd);
    if (res.status !== 202) throw new Error(`upload failed: ${res.status} ${JSON.stringify(res.json?.error)}`);
    batchIds.push(res.data.batch.id);
    console.log(`batch ${res.data.batch.id}: ${chunk.length} files, reserved ${res.data.creditsReserved} (${Date.now() - t0} ms)`);
  }

  // Responsiveness probe while the worker is busy.
  const latencies: number[] = [];
  let probing = true;
  const probe = (async () => {
    while (probing) {
      const s = Date.now();
      await fetch(`${API}/health`).then((r) => r.json()).catch(() => null);
      latencies.push(Date.now() - s);
      await new Promise((r) => setTimeout(r, 500));
    }
  })();

  const finals = [];
  for (const id of batchIds) finals.push(await waitForBatch(token, id, 20 * 60_000));
  probing = false;
  await probe;

  const counts = finals.reduce((acc: Record<string, number>, b: any) => {
    for (const [k, v] of Object.entries(b.counts || {})) acc[k] = (acc[k] || 0) + (v as number);
    return acc;
  }, {});
  const finalCount = ['done', 'failed', 'rejected', 'duplicate', 'cancelled'].reduce((s, k) => s + (counts[k] || 0), 0);
  const after = await ledgerCheck(userId);
  const p95 = latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.95)] || 0;
  const max = latencies[latencies.length - 1] || 0;

  console.log('\n=== load test ===');
  console.log(`items: ${total}, final: ${finalCount}, counts: ${JSON.stringify(counts)}`);
  console.log(`elapsed: ${Math.round((Date.now() - t0) / 1000)} s`);
  console.log(`/health latency while busy: p95 ${p95} ms, max ${max} ms (${latencies.length} probes)`);
  console.log(`credits after: ${after.credits}, ledger ${after.ledger}, charged ${before.credits - after.credits} for ${counts.done || 0} done`);

  const ok = finalCount === total && after.ok && before.credits - after.credits === (counts.done || 0) && p95 < 1500;
  console.log(ok ? 'PASS' : 'FAIL');
  if (!ok) throw new Error('load test failed its checks');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('Load test crashed:', e.message);
    process.exit(1);
  });
