create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.users (
  id uuid primary key default extensions.gen_random_uuid(),
  username text unique not null,
  password_hash text not null,
  created_at bigint not null,
  last_seen bigint,
  failed_attempts integer default 0,
  locked_until bigint default 0,
  twofa_enabled boolean default false,
  twofa_method text default null check (twofa_method is null or twofa_method = 'totp'),
  twofa_secret_enc text default null,
  twofa_secret_iv text default null,
  last_notified bigint default 0,
  email text default null,
  email_verified boolean default false,
  discord_webhook_url text default null,
  last_email_sent bigint default 0,
  notifications_disabled boolean default false
);

alter table public.users add column if not exists discord_webhook_url text default null;

create index if not exists idx_presence_users_last_seen on public.users(last_seen);
create index if not exists idx_presence_users_notifications on public.users(notifications_disabled, last_notified);

create table if not exists public.refresh_tokens (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  jti_digest text not null,
  device_info text,
  ip text,
  created_at bigint not null,
  expires_at bigint not null,
  revoked boolean default false
);

create index if not exists idx_presence_tokens_jti on public.refresh_tokens(jti_digest);
create index if not exists idx_presence_tokens_user on public.refresh_tokens(user_id);

alter table public.users enable row level security;
alter table public.refresh_tokens enable row level security;

grant usage on schema public to service_role;
grant all on table public.users to service_role;
grant all on table public.refresh_tokens to service_role;
grant usage, select on sequence public.refresh_tokens_id_seq to service_role;

do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    execute 'revoke execute on function public.rls_auto_enable() from public, anon, authenticated';
  end if;
end $$;
