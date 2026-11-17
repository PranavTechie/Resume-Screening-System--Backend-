import { supabaseAdmin } from '../config/supabase';
import { logger } from '../utils/logger';

//services
export const creditService = {
  async getBalance(userId: string): Promise<number> {
    try {
      const { data, error } = await supabaseAdmin
        .from('profiles')
        .select('credits')
        .eq('id', userId)
        .maybeSingle();

      if (!data) {
        // Safe auto-recovery: ensure missing profile & starter subscription are initialized
        try {
          await supabaseAdmin.rpc('ensure_user_profile', { p_user_id: userId });
          const { data: recovered } = await supabaseAdmin
            .from('profiles')
            .select('credits')
            .eq('id', userId)
            .maybeSingle();

          if (recovered && typeof recovered.credits === 'number') {
            return recovered.credits;
          }
        } catch (recErr: any) {
          logger.warn(`Failed to auto-recover profile for user ${userId}: ${recErr.message}`);
        }
        return 10;
      }

      return data.credits;
    } catch (err: any) {
      logger.error(`Error fetching credits balance: ${err.message}`);
      return 10;
    }
  },

  async deductCredits(
    userId: string,
    amount: number,
    description: string,
    referenceId?: string
  ): Promise<{ success: boolean; newBalance: number }> {
    try {
      // 1. Try atomic RPC function call first
      const { data, error } = await supabaseAdmin.rpc('deduct_user_credits', {
        p_user_id: userId,
        p_amount: amount,
        p_description: description,
        p_reference_id: referenceId || null,
      });

      if (!error && typeof data === 'number') {
        return { success: true, newBalance: data };
      }

      // If RPC error indicates insufficient credits or user missing, throw explicitly
      if (error && error.message?.includes('INSUFFICIENT_CREDITS')) {
        throw new Error(error.message);
      }

      // 2. Atomic fallback if RPC is not available in mock/dev environment
      const currentBalance = await this.getBalance(userId);
      if (currentBalance < amount) {
        throw new Error(`INSUFFICIENT_CREDITS: Need ${amount} credits, current balance is ${currentBalance}.`);
      }

      const newBalance = currentBalance - amount;

      const { error: updateError } = await supabaseAdmin
        .from('profiles')
        .update({ credits: newBalance, updated_at: new Date().toISOString() })
        .eq('id', userId);

      if (updateError) {
        throw new Error(`Credit deduction failed: ${updateError.message}`);
      }

      await supabaseAdmin.from('credit_transactions').insert({
        user_id: userId,
        amount: -amount,
        type: 'DEDUCTION',
        description,
        reference_id: referenceId || null,
        created_at: new Date().toISOString(),
      });

      return { success: true, newBalance };
    } catch (err: any) {
      logger.error(`Deduct credits error for user ${userId}: ${err.message}`);
      throw err;
    }
  },

  async refundCredits(
    userId: string,
    amount: number,
    description: string,
    referenceId?: string
  ): Promise<{ success: boolean; newBalance: number }> {
    try {
      const currentBalance = await this.getBalance(userId);
      const newBalance = currentBalance + amount;

      const { error: updateError } = await supabaseAdmin
        .from('profiles')
        .update({ credits: newBalance, updated_at: new Date().toISOString() })
        .eq('id', userId);

      if (updateError) {
        throw new Error(`Credit refund update failed: ${updateError.message}`);
      }

      await supabaseAdmin.from('credit_transactions').insert({
        user_id: userId,
        amount: amount,
        type: 'REFUND',
        description,
        reference_id: referenceId || null,
        created_at: new Date().toISOString(),
      });

      return { success: true, newBalance };
    } catch (err: any) {
      logger.error(`Refund credits error for user ${userId}: ${err.message}`);
      throw err;
    }
  },

  async getTransactionHistory(userId: string): Promise<any[]> {
    try {
      const { data, error } = await supabaseAdmin
        .from('credit_transactions')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      if (error) {
        logger.warn(`Error fetching credit transaction history: ${error.message}`);
        return [];
      }

      return data || [];
    } catch (err: any) {
      logger.error(`Error in getTransactionHistory for user ${userId}: ${err.message}`);
      return [];
    }
  }
};
