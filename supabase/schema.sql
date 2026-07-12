create extension if not exists pgcrypto;

create table if not exists workers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  role text not null default 'Technician',
  created_at timestamptz not null default now()
);

create table if not exists time_entries (
  id uuid primary key default gen_random_uuid(),
  worker_id uuid not null references workers(id) on delete cascade,
  action text not null check (action in ('clock_in', 'clock_out')),
  at timestamptz not null default now(),
  note text
);

create table if not exists folders (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  parent_id uuid references folders(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists project_files (
  id uuid primary key default gen_random_uuid(),
  folder_id uuid references folders(id) on delete set null,
  name text not null,
  status text not null default 'Draft',
  updated_at timestamptz not null default now()
);

alter table workers enable row level security;
alter table time_entries enable row level security;
alter table folders enable row level security;
alter table project_files enable row level security;

drop policy if exists workers_all_access on workers;
create policy workers_all_access on workers for all using (true) with check (true);

drop policy if exists time_entries_all_access on time_entries;
create policy time_entries_all_access on time_entries for all using (true) with check (true);

drop policy if exists folders_all_access on folders;
create policy folders_all_access on folders for all using (true) with check (true);

drop policy if exists project_files_all_access on project_files;
create policy project_files_all_access on project_files for all using (true) with check (true);
