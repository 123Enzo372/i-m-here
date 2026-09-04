-- Lance une vraie verification d'inactivite maintenant depuis SQL Editor.
-- Contrairement a test_inactivity_cron.sql, ce fichier ne force pas testDiscord.
-- Il utilise les secrets Vault deja crees par schedule_inactivity_cron.sql.

select net.http_post(
  url := (select decrypted_secret from vault.decrypted_secrets where name = 'presence_project_url') || '/functions/v1/inactivity-cron',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'presence_publishable_key'),
    'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'presence_publishable_key'),
    'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'presence_cron_secret')
  ),
  body := jsonb_build_object('source', 'manual-sql-run', 'time', now())
) as request_id;

-- Attends 2 a 5 secondes, puis lance cette requete pour voir la vraie reponse:
select
  id,
  status_code,
  error_msg,
  content
from net._http_response
order by created desc
limit 5;
