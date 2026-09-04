-- Debug des utilisateurs vus par inactivity-cron.
-- Lance ce fichier dans Supabase SQL Editor.

select
  count(*) as total_users,
  count(*) filter (where last_seen is not null) as users_with_last_seen,
  count(*) filter (where notifications_disabled = false) as users_notifications_enabled,
  count(*) filter (
    where last_seen is not null
      and notifications_disabled = false
  ) as users_checked_by_function
from public.users;

select
  username,
  last_seen,
  to_timestamp(last_seen / 1000.0) as last_seen_date,
  floor((extract(epoch from now()) * 1000 - last_seen) / 86400000) as inactive_days,
  notifications_disabled,
  last_notified,
  last_email_sent,
  email is not null as has_email,
  discord_webhook_url is not null as has_discord_webhook
from public.users
order by last_seen nulls first
limit 20;

-- Pour preparer un utilisateur de test J+7, remplace USERNAME_A_TESTER.
-- update public.users
-- set
--   last_seen = floor(extract(epoch from now()) * 1000)::bigint - 7 * 24 * 60 * 60 * 1000 - 1000,
--   notifications_disabled = false,
--   last_notified = 0,
--   last_email_sent = 0
-- where username = 'USERNAME_A_TESTER';
