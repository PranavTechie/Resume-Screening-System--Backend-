import { supabaseAdmin } from '../config/supabase';
import { logger } from '../utils/logger';
import { AppError } from '../utils/errors';

function insufficient(message: string, required?: number, available?: number): AppError {
  return new AppError('INSUFFICIENT_CREDITS', message, {
    status: 402,
    details: { requiredCredits: required, availableCredits: available },
  });
}

/**
 * Credits are enforced server-side through two atomic Postgres RPCs (service_role only):
 *  - reserve_credits(user, amount, reference): lock profile, check, deduct, 1 DEDUCTION ledger row
 *  - refund_credit(user, jobId, reason): +1 credit, 1 REFUND ledger row, idempotent per job
 */
export const creditService = {
  async getBalance(userId: string): Promise<number> {
    const { data, error } = await supabaseAdmin.from('profiles').select('credits').eq('id', userId).maybeSingle();
    if (error) {
      throw new AppError('CREDITS_UNAVAILABLE', 'Could not read your credit balance. Please try again.', { status: 503, retryable: true });
    }
    if (data && typeof data.credits === 'number') return data.credits;

    // Missing profile (e.g. trigger failed at signup): create it with the standard welcome bonus.
    const { error: rpcErr } = await supabaseAdmin.rpc('ensure_user_profile', { p_user_id: userId });
    if (rpcErr) logger.warn('credits.ensure_profile_failed', { error: rpcErr.message });
    const { data: recovered } = await supabaseAdmin.from('profiles').select('credits').eq('id', userId).maybeSingle();
    if (recovered && typeof recovered.credits === 'number') return recovered.credits;
    throw new AppError('CREDITS_UNAVAILABLE', 'Your account profile is not ready yet. Please sign out and in again.', { status: 503 });
  },

  /** Reserve credits up front. Returns the new balance. Throws INSUFFICIENT_CREDITS (402). */
  async reserveCredits(userId: string, amount: number, referenceId: string, description: string): Promise<number> {
    const { data, error } = await supabaseAdmin.rpc('reserve_credits', {
      p_user_id: userId,
      p_amount: amount,
      p_batch_id: referenceId,
      p_description: description,
    });
    if (error) {
      if (error.message?.includes('INSUFFICIENT_CREDITS')) {
        const available = await this.getBalance(userId).catch(() => undefined);
        throw insufficient(
          `This needs ${amount} credit${amount === 1 ? '' : 's'}, but you have ${available ?? 'fewer'}.`,
          amount,
          available
        );
      }
      if (error.message?.includes('USER_NOT_FOUND')) {
        await this.getBalance(userId); // creates the profile if missing
        return this.reserveCredits(userId, amount, referenceId, description);
      }
      logger.error('credits.reserve_failed', { error: error.message });
      throw new AppError('CREDITS_UNAVAILABLE', 'Could not reserve credits. Please try again.', { status: 503, retryable: true });
    }
    return data as number;
  },

  /**
   * Refund 1 credit for a processing job / single reservation. Idempotent: a second call for the
   * same job returns { refunded: false }. Never throws for "already refunded".
   */
  async refundCredit(userId: string, jobId: string, reason: string): Promise<{ refunded: boolean; newBalance: number | null }> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const { data, error } = await supabaseAdmin.rpc('refund_credit', { p_user_id: userId, p_job_id: jobId, p_reason: reason });
      if (!error) {
        return { refunded: typeof data === 'number', newBalance: typeof data === 'number' ? data : null };
      }
      logger.error('credits.refund_failed', { jobId, attempt, error: error.message });
      await new Promise((r) => setTimeout(r, 300 * attempt));
    }
    // Surfaced by the reconciliation check; never silently swallowed.
    throw new AppError('REFUND_FAILED', 'Could not refund the credit. Our team has been notified.', { status: 500 });
  },

  async getTransactionHistory(userId: string): Promise<any[]> {
    const { data, error } = await supabaseAdmin
      .from('credit_transactions')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) {
      logger.warn('credits.history_failed', { error: error.message });
      return [];
    }
    return data || [];
  },

  /** Log-only reconciliation: profiles where credits != ledger sum. Never auto-fixes. */
  async reconcile(): Promise<number> {
    const { data, error } = await supabaseAdmin.rpc('reconcile_credits');
    if (error) {
      logger.warn('credits.reconcile_failed', { error: error.message });
      return -1;
    }
    const rows = (data || []) as Array<{ profile_id: string; credits: number; ledger_total: number }>;
    for (const r of rows) {
      logger.warn('credits.mismatch', { profileId: r.profile_id, credits: r.credits, ledgerTotal: Number(r.ledger_total) });
    }
    logger.info('credits.reconcile_done', { mismatches: rows.length });
    return rows.length;
  },
};
