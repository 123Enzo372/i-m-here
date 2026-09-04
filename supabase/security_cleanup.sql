-- Nettoyage des alertes Supabase Security Advisor.
-- Lance ce fichier dans Supabase SQL Editor, puis relance le Security Advisor.

create schema if not exists extensions;
create schema if not exists vault;

-- Les fonctions PostgreSQL sont executables par PUBLIC par defaut.
-- Cette fonction n'est pas appelee par l'application, donc on retire l'acces public.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    execute 'revoke execute on function public.rls_auto_enable() from public, anon, authenticated';
  end if;
end $$;

-- Evite que les nouvelles fonctions creees dans public soient executables par defaut.
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon, authenticated;

-- Deplace les extensions relocatables hors du schema public quand c'est possible.
do $$
declare
  extension_name text;
begin
  foreach extension_name in array array['pgcrypto', 'pg_cron'] loop
    if exists (
      select 1
      from pg_extension
      where extname = extension_name
        and extrelocatable
        and extnamespace = 'public'::regnamespace
    ) then
      execute format('alter extension %I set schema extensions', extension_name);
    end if;
  end loop;
end $$;

-- pg_net peut etre non relocatable sur Supabase.
-- Si l'alerte public.pg_net reste apres ce script, choisis une de ces options:
-- 1. Le plus prudent: demander au support Supabase de deplacer pg_net hors de public.
-- 2. Si tu n'as pas de Database Webhooks et que tu acceptes de recreer le cron:
--    a) lance: select cron.unschedule('presence-inactivity-daily');
--    b) lance: drop extension if exists pg_net cascade;
--    c) lance: create extension pg_net with schema extensions;
--    d) relance supabase/schedule_inactivity_cron.sql.
