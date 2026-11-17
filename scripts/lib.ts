/**
 * Helpers for the smoke / load scripts. They talk to a RUNNING backend over HTTP like the frontend does.
 * Test users are created with the Supabase admin API (confirmed, no email sent) and only ever get
 * generated, obviously fake resumes. Never point these scripts at real people's data.
 */
import crypto from 'crypto';
import path from 'path';
import dotenv from 'dotenv';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

// ---------------------------------------------------------------------------
// Safety gate: this project has only ONE Supabase project (no separate dev/
// staging DB), and these scripts use the service-role key + make real Gemini
// calls. Require an explicit opt-in every run so nobody fires them by habit
// (e.g. muscle-memory `npm run smoke`) against production without meaning to.
// ---------------------------------------------------------------------------
if (process.env.CONFIRM_LIVE_TEST !== 'yes') {
  console.error(
    `\n⚠️  Refusing to run: this talks to the LIVE production Supabase project (${process.env.SUPABASE_URL || '(SUPABASE_URL not set)'}) and makes real Gemini calls.\n` +
      `There is no separate dev/staging database. Test users (@example.com) and their data are cleaned up automatically after the run, but Gemini quota is real and not refundable.\n\n` +
      `If you're sure, re-run with:\n  CONFIRM_LIVE_TEST=yes <your command>\n`
  );
  process.exit(1);
}

export const API = (process.env.API_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');

export function admin(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing in backend/.env');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** Create (or reuse) a confirmed test user and return an access token. Password is random and never printed. */
export async function testUserSession(email: string): Promise<{ userId: string; token: string }> {
  const sb = admin();
  const password = `T${crypto.randomBytes(18).toString('base64url')}!9`;
  const { data: created, error } = await sb.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: 'Automated Test User' } });
  let userId = created?.user?.id;
  if (error) {
    // Already exists: look it up and reset its password to the fresh random one.
    const { data: list } = await sb.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const existing = list?.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (!existing) throw new Error(`Could not create test user: ${error.message}`);
    userId = existing.id;
    await sb.auth.admin.updateUserById(existing.id, { password });
  }
  const anon = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  const { data: session, error: signErr } = await anon.auth.signInWithPassword({ email, password });
  if (signErr || !session.session) throw new Error(`Sign-in failed: ${signErr?.message}`);
  return { userId: userId!, token: session.session.access_token };
}

/** Give a TEST user credits, ledger-consistent (BONUS row + balance), so reconciliation stays clean. */
export async function topUpTestCredits(userId: string, amount: number): Promise<void> {
  const sb = admin();
  const { data: prof } = await sb.from('profiles').select('credits, email').eq('id', userId).single();
  if (!prof?.email?.endsWith('@example.com')) throw new Error('Refusing to top up a non-test account');
  await sb.from('credit_transactions').insert({ user_id: userId, amount, type: 'BONUS', description: 'Automated test credits', reference_id: `test-topup:${Date.now()}` });
  await sb.from('profiles').update({ credits: (prof.credits || 0) + amount }).eq('id', userId);
}

/**
 * Fully remove a test account and everything it owns. Every public table's user_id FK is
 * ON DELETE CASCADE back to auth.users, so deleting the auth user is enough — no orphans.
 * Hard-refuses any email not ending in @example.com so a typo can never touch a real account.
 */
export async function cleanupTestUser(email: string): Promise<void> {
  if (!email.toLowerCase().endsWith('@example.com')) {
    throw new Error(`cleanupTestUser refused: "${email}" is not a @example.com test address`);
  }
  const sb = admin();
  const { data: list } = await sb.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const existing = list?.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
  if (!existing) return; // nothing to clean up
  const { error } = await sb.auth.admin.deleteUser(existing.id);
  if (error) console.error(`cleanup: failed to delete ${email}: ${error.message}`);
  else console.log(`cleanup: removed test account ${email} and all its data`);
}

export async function ledgerCheck(userId: string): Promise<{ credits: number; ledger: number; ok: boolean }> {
  const sb = admin();
  const { data: prof } = await sb.from('profiles').select('credits').eq('id', userId).single();
  const { data: rows } = await sb.from('credit_transactions').select('amount').eq('user_id', userId);
  const ledger = (rows || []).reduce((s, r: any) => s + r.amount, 0);
  return { credits: prof?.credits ?? -1, ledger, ok: prof?.credits === ledger };
}

export async function api<T = any>(token: string, method: string, route: string, body?: unknown): Promise<{ status: number; json: any; data: T }> {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json, data: json?.data };
}

export async function waitForBatch(token: string, batchId: string, timeoutMs = 10 * 60_000): Promise<any> {
  const start = Date.now();
  for (;;) {
    const { data } = await api(token, 'GET', `/api/batches/${batchId}`);
    if (data && data.status !== 'active') return data;
    if (Date.now() - start > timeoutMs) throw new Error(`Batch ${batchId} did not finish in time`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// ---------------------------------------------------------------------------
// Fake resume generator (obviously fictional people, example.com emails)
// ---------------------------------------------------------------------------
const FIRST = ['Aarav', 'Diya', 'Kabir', 'Meera', 'Rohan', 'Isha', 'Vivaan', 'Anaya', 'Arjun', 'Sara', 'Dev', 'Tara'];
const LAST = ['Testwala', 'Sampleton', 'Fakeman', 'Demora', 'Mockrao', 'Placeholder'];
const SKILLS = ['React', 'TypeScript', 'JavaScript', 'Node.js', 'Python', 'SQL', 'PostgreSQL', 'Docker', 'AWS', 'Git', 'HTML', 'CSS', 'Django', 'Machine Learning', 'Pandas', 'Figma', 'Excel', 'Java'];

export function fakeResume(i: number): { name: string; text: string } {
  const name = `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]} ${String(i).padStart(2, '0')}`;
  const skills = SKILLS.filter((_, k) => (k * 31 + i * 17) % 3 !== 0).slice(0, 6 + (i % 5));
  const years = 1 + (i % 7);
  const start = 2024 - years;
  const text = `${name}
Email: test.candidate${i}@example.com | Phone: +91 90000 ${String(10000 + i).slice(-5)} | linkedin.com/in/fake-candidate-${i}

PROFESSIONAL SUMMARY
Fictional ${years}-year software developer generated for automated testing. Not a real person.

WORK EXPERIENCE
Software Developer, Example Labs Pvt Ltd                         Jan ${start} – Present
- Built internal dashboards with ${skills[0]} and ${skills[1] || 'SQL'}, used by ${10 + i} colleagues.
- Reduced report generation time by ${10 + (i % 50)}% by rewriting queries.
- Wrote unit tests and reviewed pull requests weekly.

Intern, Sample Systems                                            Jun ${start - 1} - Dec ${start - 1}
- Assisted with data cleaning scripts and documentation.

EDUCATION
B.Tech in Computer Science, Imaginary Institute of Technology      ${start - 5} - ${start - 1}

SKILLS
${skills.join(', ')}

PROJECTS
- Expense tracker web app (${skills.slice(0, 2).join(', ')})
- Resume parser demo (${skills.slice(2, 4).join(', ') || 'Python'})
`;
  return { name, text };
}

export const JUNK_TEXT = `TAX INVOICE No 99812
Item: Printer cartridge x 2 ........ 1,250.00 INR
Item: A4 paper box x 5 ............. 1,900.00 INR
Amount due: 3,150.00 INR. Payment by bank transfer. Thank you for shopping with Example Stationers.
`.repeat(4);

export const SAMPLE_JD = `We are hiring a Frontend Developer with 2+ years of experience.

Required skills: React, TypeScript, JavaScript, HTML, CSS, Git, REST APIs.
Nice to have: Node.js, Docker, AWS, Figma.

Responsibilities: build and maintain web applications, write tested code, collaborate with designers and backend developers, review pull requests.`;
