import { supabaseAdmin } from '../config/supabase';
import { logger } from '../utils/logger';
import { creditService } from './credit.service';

export type UserPlan = 'free' | 'pro' | 'career_max';

export interface EntitlementCheck {
  plan: UserPlan;
  isUnlimitedCredits: boolean;
}

export const entitlementService = {
  /**
   * Resolves the exact plan entitlement for a given user
   */
  async getEntitlements(userId: string, email?: string): Promise<EntitlementCheck> {
    try {
      // Query Supabase subscriptions table
      const { data: sub } = await supabaseAdmin
        .from('subscriptions')
        .select('plan_id, status')
        .eq('user_id', userId)
        .maybeSingle();

      const rawPlan = (sub?.plan_id || 'free').toLowerCase();

      const mappedPlan: UserPlan = 
        rawPlan === 'pro' || rawPlan === 'pro_career' ? 'pro' :
        rawPlan === 'career_max' || rawPlan === 'max' ? 'career_max' : 'free';

      return {
        plan: mappedPlan,
        isUnlimitedCredits: false,
      };
    } catch (err: any) {
      logger.warn(`Error resolving entitlements for user ${userId}: ${err.message}`);
      return {
        plan: 'free',
        isUnlimitedCredits: false,
      };
    }
  },

  /**
   * Server-side feature access verification helper
   * Under the credit-only model, all features are accessible across all plans.
   */
  async canUseFeature(userId: string, featureName: string, email?: string): Promise<boolean> {
    return true;
  },

  /**
   * Server-side credit availability check
   */
  async hasCredits(userId: string, requiredAmount: number, email?: string): Promise<boolean> {
    const balance = await creditService.getBalance(userId);
    return balance >= requiredAmount;
  }
};
