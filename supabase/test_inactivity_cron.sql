-- Test manuel depuis SQL Editor.
-- 1. Lance le premier SELECT.
-- 2. Attends 2 a 5 secondes.
-- 3. Lance le SELECT net._http_response en bas du fichier.

select net.http_post(
  url := (select decrypted_secret from vault.decrypted_secrets where name = 'presence_project_url') || '/functions/v1/inactivity-cron',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'presence_publishable_key'),
    'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'presence_publishable_key'),
    'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'presence_cron_secret')
  ),
  body := jsonb_build_object('testDiscord', true)
) as request_id;

select
  id,
  status_code,
  error_msg,
  content
from net._http_response
order by created desc
limit 5;
