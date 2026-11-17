import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * In-memory stand-in for the two Postgres RPCs. It mirrors the SQL exactly:
 *  reserve_credits: check balance, deduct, ONE DEDUCTION row
 *  refund_credit  : REFUND row unique per reference (idempotent), only for charged jobs
 * The real SQL was additionally verified against the live DB inside a rolled-back transaction.
 */
const db = vi.hoisted(() => ({
  credits: 0,
  ledger: [] as Array<{ type: string; amount: number; ref: string }>,
  jobs: new Map<string, { charged: boolean; round: number }>(),
}));

vi.mock('../src/config/supabase', () => {
  const rpc = async (fn: string, args: any) => {
    if (fn === 'reserve_credits') {
      if (db.credits < args.p_amount) return { data: null, error: { message: `INSUFFICIENT_CREDITS: need ${args.p_amount}, available ${db.credits}` } };
      db.credits -= args.p_amount;
      db.ledger.push({ type: 'DEDUCTION', amount: -args.p_amount, ref: args.p_batch_id });
      return { data: db.credits, error: null };
    }
    if (fn === 'refund_credit') {
      const job = db.jobs.get(args.p_job_id);
      let ref = args.p_job_id;
      if (job) {
        if (!job.charged) return { data: null, error: null };
        ref = job.round === 0 ? args.p_job_id : `${args.p_job_id}:r${job.round}`;
      } else if (!db.ledger.some((l) => l.type === 'DEDUCTION' && l.ref === args.p_job_id)) {
        return { data: null, error: null };
      }
      if (db.ledger.some((l) => l.type === 'REFUND' && l.ref === ref)) return { data: null, error: null }; // unique index
      db.ledger.push({ type: 'REFUND', amount: 1, ref });
      db.credits += 1;
      if (job) job.charged = false;
      return { data: db.credits, error: null };
    }
    return { data: null, error: { message: 'unknown rpc' } };
  };
  const from = () => ({
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { credits: db.credits }, error: null }) }) }),
  });
  return { supabaseAdmin: { rpc, from }, supabaseAnon: {} };
});

import { creditService } from '../src/services/credit.service';
import { AppError } from '../src/utils/errors';

const ledgerSum = () => db.ledger.reduce((s, l) => s + l.amount, 0);

beforeEach(() => {
  db.credits = 10;
  db.ledger = [{ type: 'BONUS', amount: 10, ref: 'welcome' }];
  db.jobs.clear();
});

describe('credit reserve / refund', () => {
  it('reserves the full batch cost with ONE ledger row', async () => {
    const balance = await creditService.reserveCredits('u1', 4, 'batch-1', 'Bulk');
    expect(balance).toBe(6);
    expect(db.ledger.filter((l) => l.type === 'DEDUCTION')).toEqual([{ type: 'DEDUCTION', amount: -4, ref: 'batch-1' }]);
  });

  it('fails with INSUFFICIENT_CREDITS (402) and charges nothing', async () => {
    const err = await creditService.reserveCredits('u1', 11, 'batch-2', 'Bulk').catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('INSUFFICIENT_CREDITS');
    expect(err.status).toBe(402);
    expect(err.details).toMatchObject({ requiredCredits: 11, availableCredits: 10 });
    expect(db.credits).toBe(10);
  });

  it('refunds a job exactly once, even if called twice', async () => {
    await creditService.reserveCredits('u1', 3, 'batch-3', 'Bulk');
    db.jobs.set('job-a', { charged: true, round: 0 });
    db.jobs.set('job-b', { charged: true, round: 0 });
    db.jobs.set('job-c', { charged: true, round: 0 });

    expect(await creditService.refundCredit('u1', 'job-a', 'failed')).toEqual({ refunded: true, newBalance: 8 });
    expect(await creditService.refundCredit('u1', 'job-a', 'failed again')).toEqual({ refunded: false, newBalance: null });
    expect(await creditService.refundCredit('u1', 'job-b', 'duplicate')).toEqual({ refunded: true, newBalance: 9 });

    expect(db.credits).toBe(9);
    expect(db.ledger.filter((l) => l.type === 'REFUND')).toHaveLength(2);
    expect(ledgerSum()).toBe(db.credits); // reconciliation invariant
  });

  it('never refunds an item that was not charged (pre-detected duplicate)', async () => {
    db.jobs.set('dup', { charged: false, round: 0 });
    expect(await creditService.refundCredit('u1', 'dup', 'duplicate')).toEqual({ refunded: false, newBalance: null });
    expect(db.credits).toBe(10);
  });

  it('a retried item can be refunded again for its new round, but only once per round', async () => {
    await creditService.reserveCredits('u1', 1, 'batch-4', 'Bulk');
    db.jobs.set('job-r', { charged: true, round: 0 });
    await creditService.refundCredit('u1', 'job-r', 'failed');
    // "Retry failed": new round is reserved and charged again
    await creditService.reserveCredits('u1', 1, 'batch-4', 'Retry');
    db.jobs.set('job-r', { charged: true, round: 1 });
    expect((await creditService.refundCredit('u1', 'job-r', 'failed')).refunded).toBe(true);
    expect((await creditService.refundCredit('u1', 'job-r', 'failed')).refunded).toBe(false);
    expect(db.credits).toBe(10);
    expect(ledgerSum()).toBe(db.credits);
  });

  it('single-upload reservation refund requires a matching DEDUCTION', async () => {
    expect((await creditService.refundCredit('u1', 'never-reserved', 'x')).refunded).toBe(false);
    await creditService.reserveCredits('u1', 1, 'resv-1', 'Resume analysis');
    expect((await creditService.refundCredit('u1', 'resv-1', 'not a resume')).refunded).toBe(true);
    expect((await creditService.refundCredit('u1', 'resv-1', 'not a resume')).refunded).toBe(false);
    expect(db.credits).toBe(10);
  });
});
