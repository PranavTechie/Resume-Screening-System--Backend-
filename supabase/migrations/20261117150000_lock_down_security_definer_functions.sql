-- 2026-11-17: lock down SECURITY DEFINER functions flagged by the Supabase security advisor.
-- deduct_user_credits was callable by anon/authenticated via /rest/v1/rpc with ANY user id,
-- letting anyone drain another user's credits. Only the backend (service_role) should call it.

REVOKE EXECUTE ON FUNCTION public.deduct_user_credits(uuid, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.deduct_user_credits(uuid, integer, text, text) TO service_role;

-- Trigger function: never needs to be called through the API.
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

-- Called by the backend (service_role) and by signed-in users from the frontend; not by anon.
REVOKE EXECUTE ON FUNCTION public.ensure_user_profile(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.ensure_user_profile(uuid) TO authenticated, service_role;

-- Advisor: function_search_path_mutable
ALTER FUNCTION public.prevent_direct_credit_update() SET search_path = public, pg_temp;
