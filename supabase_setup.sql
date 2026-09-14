-- Daily Journal 差分同期版 / 初回セットアップ SQL
-- Supabase Dashboard > SQL Editor で1回だけ実行してください。
-- ブラウザには Publishable/anon key のみ置き、service_role/secret key は絶対に公開しません。

create table if not exists public.daily_journal_entries (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  date_key text,
  time text,
  text text not null default '',
  category text,
  slack_type text,
  image_paths jsonb not null default '[]'::jsonb,
  external_images jsonb not null default '[]'::jsonb,
  created_client_at timestamptz,
  client_updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.daily_journal_notebooks (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default '',
  content text not null default '',
  category text,
  status text not null default 'archive',
  linked_note_ids jsonb not null default '[]'::jsonb,
  created_client_at timestamptz,
  client_updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.daily_journal_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state jsonb not null default '{}'::jsonb,
  client_updated_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists daily_journal_entries_user_updated_idx
  on public.daily_journal_entries(user_id, updated_at);
create index if not exists daily_journal_notebooks_user_updated_idx
  on public.daily_journal_notebooks(user_id, updated_at);

create or replace function public.daily_journal_touch_updated_at()
returns trigger
language plpgsql
security invoker
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists daily_journal_entries_touch_updated_at on public.daily_journal_entries;
create trigger daily_journal_entries_touch_updated_at
before update on public.daily_journal_entries
for each row execute function public.daily_journal_touch_updated_at();

drop trigger if exists daily_journal_notebooks_touch_updated_at on public.daily_journal_notebooks;
create trigger daily_journal_notebooks_touch_updated_at
before update on public.daily_journal_notebooks
for each row execute function public.daily_journal_touch_updated_at();

drop trigger if exists daily_journal_settings_touch_updated_at on public.daily_journal_settings;
create trigger daily_journal_settings_touch_updated_at
before update on public.daily_journal_settings
for each row execute function public.daily_journal_touch_updated_at();

alter table public.daily_journal_entries enable row level security;
alter table public.daily_journal_notebooks enable row level security;
alter table public.daily_journal_settings enable row level security;

revoke all on table public.daily_journal_entries, public.daily_journal_notebooks, public.daily_journal_settings from anon;
grant select, insert, update, delete on table public.daily_journal_entries, public.daily_journal_notebooks, public.daily_journal_settings to authenticated;

-- Journal
drop policy if exists "journal entries select own" on public.daily_journal_entries;
create policy "journal entries select own"
on public.daily_journal_entries for select to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "journal entries insert own" on public.daily_journal_entries;
create policy "journal entries insert own"
on public.daily_journal_entries for insert to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "journal entries update own" on public.daily_journal_entries;
create policy "journal entries update own"
on public.daily_journal_entries for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "journal entries delete own" on public.daily_journal_entries;
create policy "journal entries delete own"
on public.daily_journal_entries for delete to authenticated
using ((select auth.uid()) = user_id);

-- Notebooks
drop policy if exists "notebooks select own" on public.daily_journal_notebooks;
create policy "notebooks select own"
on public.daily_journal_notebooks for select to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "notebooks insert own" on public.daily_journal_notebooks;
create policy "notebooks insert own"
on public.daily_journal_notebooks for insert to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "notebooks update own" on public.daily_journal_notebooks;
create policy "notebooks update own"
on public.daily_journal_notebooks for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "notebooks delete own" on public.daily_journal_notebooks;
create policy "notebooks delete own"
on public.daily_journal_notebooks for delete to authenticated
using ((select auth.uid()) = user_id);

-- Settings
drop policy if exists "settings select own" on public.daily_journal_settings;
create policy "settings select own"
on public.daily_journal_settings for select to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "settings insert own" on public.daily_journal_settings;
create policy "settings insert own"
on public.daily_journal_settings for insert to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "settings update own" on public.daily_journal_settings;
create policy "settings update own"
on public.daily_journal_settings for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "settings delete own" on public.daily_journal_settings;
create policy "settings delete own"
on public.daily_journal_settings for delete to authenticated
using ((select auth.uid()) = user_id);

-- Private Storage bucket
insert into storage.buckets (id, name, public)
values ('daily-journal-images', 'daily-journal-images', false)
on conflict (id) do nothing;

drop policy if exists "daily journal images insert own" on storage.objects;
create policy "daily journal images insert own"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'daily-journal-images'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

drop policy if exists "daily journal images select own" on storage.objects;
create policy "daily journal images select own"
on storage.objects for select to authenticated
using (
  bucket_id = 'daily-journal-images'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

drop policy if exists "daily journal images update own" on storage.objects;
create policy "daily journal images update own"
on storage.objects for update to authenticated
using (
  bucket_id = 'daily-journal-images'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
)
with check (
  bucket_id = 'daily-journal-images'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

drop policy if exists "daily journal images delete own" on storage.objects;
create policy "daily journal images delete own"
on storage.objects for delete to authenticated
using (
  bucket_id = 'daily-journal-images'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);
