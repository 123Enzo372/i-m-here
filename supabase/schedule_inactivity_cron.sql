create schema if not exists extensions;
create schema if not exists vault;
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;
create extension if not exists supabase_vault with schema vault;

-- Remplace ces 3 valeurs avant d'executer le script.
-- project_url = https://<project-ref>.supabase.co
-- publishable_key = la cle Publishable ou anon, seulement pour appeler la fonction
-- cron_secret = la meme valeur que le secret Edge Function CRON_SECRET
do $$
declare
  project_url text := 'https://<project-ref>.supabase.co';
  publishable_key text := '<publishable-or-anon-key>';
  cron_secret text := '<same-value-as-CRON_SECRET>';
  existing_secret_id uuid;
begin
  select id into existing_secret_id from vault.secrets where name = 'presence_project_url';
  if existing_secret_id is null then
    perform vault.create_secret(project_url, 'presence_project_url');
  else
    perform vault.update_secret(existing_secret_id, project_url);
  end if;

  select id into existing_secret_id from vault.secrets where name = 'presence_publishable_key';
  if existing_secret_id is null then
    perform vault.create_secret(publishable_key, 'presence_publishable_key');
  else
    perform vault.update_secret(existing_secret_id, publishable_key);
  end if;

  select id into existing_secret_id from vault.secrets where name = 'presence_cron_secret';
  if existing_secret_id is null then
    perform vault.create_secret(cron_secret, 'presence_cron_secret');
  else
    perform vault.update_secret(existing_secret_id, cron_secret);
  end if;
end $$;

select cron.unschedule('presence-inactivity-daily')
where exists (
  select 1 from cron.job where jobname = 'presence-inactivity-daily'
);

select cron.schedule(
  'presence-inactivity-daily',
  '0 0 * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'presence_project_url') || '/functions/v1/inactivity-cron',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'presence_publishable_key'),
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'presence_publishable_key'),
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'presence_cron_secret')
    ),
    body := jsonb_build_object('source', 'supabase-cron', 'time', now())
  ) as request_id;
  $$
);
