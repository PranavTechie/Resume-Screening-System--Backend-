-- ====================================================================
-- ResumeIQ Migration: Auth Hardening, 10-Credit Welcome Bonus & Credit Protection
-- File: 20260811150000_harden_auth_and_welcome_credits.sql
-- Description: Incremental migration to align subscription defaults to 'starter',
--              set initial welcome credits to 10, harden SECURITY DEFINER search_path,
--              enforce unique welcome bonus transactions, and restrict client credit updates.
-- ====================================================================

-- 1. ALIGN DEFAULT COLUMN VALUES FOR PROFILES & SUBSCRIPTIONS
ALTER TABLE public.profiles 
  ALTER COLUMN credits SET DEFAULT 10;

ALTER TABLE public.subscriptions 
  ALTER COLUMN plan_id SET DEFAULT 'starter';

-- 2. ENFORCE SINGLE WELCOME BONUS PER USER AT DATABASE INDEX LEVEL
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_welcome_bonus 
  ON public.credit_transactions(user_id, type) 
  WHERE (type = 'BONUS' AND description = 'Welcome bonus');

-- 3. HARDENED AUTOMATIC NEW USER SETUP TRIGGER
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  -- 1. Create Profile with 10 initial welcome credits
  INSERT INTO public.profiles (id, email, full_name, avatar_url, credits)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', SPLIT_PART(NEW.email, '@', 1)),
    NEW.raw_user_meta_data->>'avatar_url',
    10
  )
  ON CONFLICT (id) DO NOTHING;

  -- 2. Create User Preferences
  INSERT INTO public.user_preferences (user_id)
  VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING;

  -- 3. Create Subscription with 'starter' plan
  INSERT INTO public.subscriptions (user_id, plan_id, status)
  VALUES (NEW.id, 'starter', 'active')
  ON CONFLICT (user_id) DO NOTHING;

  -- 4. Record Welcome Bonus Credit Transaction (10 credits, ONCE per user)
  INSERT INTO public.credit_transactions (
    user_id,
    amount,
    type,
    description,
    reference_id,
    created_at
  ) VALUES (
    NEW.id,
    10,
    'BONUS',
    'Welcome bonus',
    NEW.id::text,
    NOW()
  )
  ON CONFLICT (user_id, type) WHERE (type = 'BONUS' AND description = 'Welcome bonus') DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 4. ATOMIC CREDIT DEDUCTION RPC PROCEDURE (SECURITY DEFINER WITH SEARCH PATH)
CREATE OR REPLACE FUNCTION public.deduct_user_credits(
  p_user_id UUID,
  p_amount INTEGER,
  p_description TEXT,
  p_reference_id TEXT DEFAULT NULL
)
RETURNS INTEGER AS $$
DECLARE
  v_current_credits INTEGER;
  v_new_credits INTEGER;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Deduction amount must be greater than zero.';
  END IF;

  -- Lock profile row for update atomically to prevent race conditions
  SELECT credits INTO v_current_credits
  FROM public.profiles
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'USER_NOT_FOUND: User profile does not exist.';
  END IF;

  IF v_current_credits < p_amount THEN
    RAISE EXCEPTION 'INSUFFICIENT_CREDITS: Need % credits, current balance is %.', p_amount, v_current_credits;
  END IF;

  v_new_credits := v_current_credits - p_amount;

  UPDATE public.profiles
  SET credits = v_new_credits, updated_at = NOW()
  WHERE id = p_user_id;

  INSERT INTO public.credit_transactions (
    user_id, amount, type, description, reference_id, created_at
  ) VALUES (
    p_user_id, -p_amount, 'DEDUCTION', p_description, p_reference_id, NOW()
  );

  RETURN v_new_credits;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- 5. CLIENT CREDIT MUTATION DEFENSE TRIGGER
CREATE OR REPLACE FUNCTION public.prevent_direct_credit_update()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.credits IS DISTINCT FROM OLD.credits AND current_user = 'authenticated' THEN
    RAISE EXCEPTION 'DIRECT_CREDIT_UPDATE_DENIED: Modifying credits via client update is strictly prohibited.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS enforce_credit_security ON public.profiles;
CREATE TRIGGER enforce_credit_security
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.prevent_direct_credit_update();
