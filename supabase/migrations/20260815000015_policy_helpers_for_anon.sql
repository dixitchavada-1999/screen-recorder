-- ---------------------------------------------------------------------------
-- Let an unauthenticated request see nothing, rather than fail oddly
--
-- The previous migration granted the two policy helpers to `authenticated` and
-- took them away from everybody else. That reads like the careful choice, and
-- it is the wrong one: a policy is evaluated as whoever is asking, so a request
-- arriving without a session cannot run the function and the read fails with
--
--   42501  permission denied for function is_on_call
--
-- instead of returning nothing. Which matters at the one moment it is most
-- confusing: an expired token makes an ordinary request anonymous, and the
-- person at the screen is shown a function name where they should be shown
-- "sign in again".
--
-- Granting it back costs nothing. Both functions answer only about the caller,
-- and for an anonymous caller `auth.uid()` and `my_nexus_id()` are null, so
-- both return false and the policies deny — which is the intended answer,
-- arrived at properly.
-- ---------------------------------------------------------------------------

grant execute on function public.is_on_call(uuid)      to anon;
grant execute on function public.scheduled_by_me(uuid) to anon;
grant execute on function public.my_nexus_id()         to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Check
--
--   -- with no Authorization header this must return [] rather than 42501
--   -- GET /rest/v1/scheduled_calls?select=id&limit=1
-- ---------------------------------------------------------------------------
