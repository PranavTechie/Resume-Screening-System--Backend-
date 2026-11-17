/**
 * Edge cases against a running backend (use AI_MOCK_MODE=true on a dev server):
 * cancel refunds, ZIP upload, unsafe ZIP rejected, same-candidate dedupe in a job, rejection cap (429).
 * Hits the single live Supabase project (no dev/staging DB exists) — the test account it creates is
 * deleted automatically when the script exits, pass or fail.
 *   CONFIRM_LIVE_TEST=yes API_URL=http://localhost:3005 npx tsx scripts/edgeCases.ts
 */
import yazl from 'yazl';
import { api, cleanupTestUser, fakeResume, JUNK_TEXT, ledgerCheck, SAMPLE_JD, testUserSession, topUpTestCredits, waitForBatch } from './lib';

const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, info = '') => {
  results.push([name, ok, info]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`);
};
const balance = async (t: string) => (await api(t, 'GET', '/api/credits/balance')).data.credits as number;

function zipOf(entries: Array<{ name: string; data: string }>): Promise<Buffer> {
  return new Promise((resolve) => {
    const z = new yazl.ZipFile();
    entries.forEach((e) => z.addBuffer(Buffer.from(e.data), e.name));
    z.end();
    const chunks: Buffer[] = [];
    z.outputStream.on('data', (c: Buffer) => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks)));
  });
}

async function main() {
  const email = process.env.EDGE_EMAIL || 'rss.edge.test@example.com';
  try {
    await runEdgeCases(email);
  } finally {
    await cleanupTestUser(email);
  }
}

async function runEdgeCases(email: string) {
  const { userId, token } = await testUserSession(email);
  if ((await balance(token)) < 30) await topUpTestCredits(userId, 30);
  const tag = Date.now();

  // 1. Cancel right after queueing: every cancelled item is refunded.
  const fd = new FormData();
  fd.append('consent', 'true');
  for (let i = 0; i < 12; i++) fd.append('files', new File([`${fakeResume(100 + i).text}\n${tag}-c`], `c_${i}.txt`, { type: 'text/plain' }));
  const b0 = await balance(token);
  const up = await api(token, 'POST', '/api/batches/upload', fd);
  const cancel = await api(token, 'POST', `/api/batches/${up.data.batch.id}/cancel`);
  const fin = await waitForBatch(token, up.data.batch.id);
  const b1 = await balance(token);
  const done = fin.counts.done || 0;
  check('cancel: charged only for items that finished', b0 - b1 === done, `done ${done}, cancelled ${fin.counts.cancelled || 0}, ${b0} -> ${b1}, cancel status ${cancel.status}`);

  // 2. No consent -> 400
  const fdNo = new FormData();
  fdNo.append('files', new File(['x'], 'a.txt'));
  const noConsent = await api(token, 'POST', '/api/batches/upload', fdNo);
  check('bulk without consent rejected', noConsent.status === 400 && noConsent.json?.error?.code === 'CONSENT_REQUIRED');

  // 3. ZIP with 2 resumes + 1 unsupported file
  const zip = await zipOf([
    { name: 'cvs/z1.txt', data: `${fakeResume(201).text}\n${tag}-z` },
    { name: 'cvs/z2.txt', data: `${fakeResume(202).text}\n${tag}-z` },
    { name: 'cvs/notes.exe', data: 'MZ' },
  ]);
  const fdz = new FormData();
  fdz.append('consent', 'true');
  fdz.append('zip', new File([zip], 'resumes.zip', { type: 'application/zip' }));
  const zr = await api(token, 'POST', '/api/batches/upload', fdz);
  const zfin = zr.status === 202 ? await waitForBatch(token, zr.data.batch.id) : null;
  check('ZIP: 2 analyzed, exe skipped free', zr.data?.creditsReserved === 2 && zfin?.counts?.done === 2 && zfin?.counts?.rejected === 1, JSON.stringify(zfin?.counts));

  // 4. Unsafe ZIP (nested archive) -> 400, nothing charged
  const nested = await zipOf([{ name: 'inner.zip', data: 'PK' }]);
  const fdn = new FormData();
  fdn.append('consent', 'true');
  fdn.append('zip', new File([nested], 'bad.zip', { type: 'application/zip' }));
  const b2 = await balance(token);
  const nr = await api(token, 'POST', '/api/batches/upload', fdn);
  check('nested ZIP rejected, no charge', nr.status === 400 && nr.json?.error?.code === 'ZIP_NESTED_ARCHIVE' && (await balance(token)) === b2, nr.json?.error?.code);

  // 5. Same candidate (same email) twice inside one job: ranked once.
  const ids = (zfin?.items || []).filter((i: any) => i.status === 'done').map((i: any) => i.resultRef);
  const same = fakeResume(201).text.replace(/\n/, '\nAlternate version\n');
  const fds = new FormData();
  fds.append('file', new File([`${same}\n${tag}-same`], 'same_person_v2.txt', { type: 'text/plain' }));
  const v2 = await api(token, 'POST', '/api/resumes', fds);
  const job = await api(token, 'POST', '/api/jobs', { title: 'Dedupe check', description: SAMPLE_JD });
  await api(token, 'POST', `/api/jobs/${job.data.id}/attach`, { resumeIds: [...ids, v2.data?.resume?.id].filter(Boolean) });
  const rank = await api(token, 'POST', `/api/jobs/${job.data.id}/rank`);
  const rfin = rank.status === 202 ? await waitForBatch(token, rank.data.batch.id) : null;
  check('same email in one job ranked once, duplicate free', rank.data?.creditsReserved === 2 && rfin?.counts?.duplicate === 1, JSON.stringify(rfin?.counts));

  // 6. Second rank while one is running -> 409 (start + immediate second call)
  const r1 = await api(token, 'POST', `/api/jobs/${job.data.id}/rank`);
  const r2 = await api(token, 'POST', `/api/jobs/${job.data.id}/rank`);
  check('parallel ranking blocked', r1.status === 202 && r2.status === 409, `${r1.status}/${r2.status}`);
  if (r1.status === 202) await waitForBatch(token, r1.data.batch.id);

  // 7. Rejection cap: junk uploads until 429
  let capped = false;
  for (let i = 0; i < 17 && !capped; i++) {
    const f = new FormData();
    f.append('file', new File([`${JUNK_TEXT}\n${tag}-${i}`], `junk_${i}.txt`, { type: 'text/plain' }));
    const r = await api(token, 'POST', '/api/resumes', f);
    if (r.status === 429 && r.json?.error?.code === 'TOO_MANY_REJECTED_UPLOADS') capped = true;
  }
  check('15 rejections / 24h cap returns 429', capped);

  const led = await ledgerCheck(userId);
  check('credit balance == ledger', led.ok, `${led.credits} / ${led.ledger}`);
  const failed = results.filter((r) => !r[1]);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) throw new Error(`${failed.length} check(s) failed`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('Edge-case test crashed:', e.message);
    process.exit(1);
  });
