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
  project_id uuid,
  name text not null,
  parent_id uuid references folders(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists project_files (
  id uuid primary key default gen_random_uuid(),
  project_id uuid,
  folder_id uuid references folders(id) on delete set null,
  name text not null,
  mime_type text,
  storage_path text,
  uploaded_by text,
  version integer not null default 1,
  change_note text,
  status text not null default 'Draft',
  updated_at timestamptz not null default now()
);

create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text,
  client text,
  address text,
  project_manager text,
  status text not null default 'active',
  description text,
  start_date date,
  target_date date,
  created_at timestamptz not null default now()
);

create table if not exists project_members (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  email text not null,
  role text not null default 'Viewer',
  permission jsonb not null default '{}'::jsonb,
  status text not null default 'active',
  created_at timestamptz not null default now()
);

create table if not exists project_file_versions (
  id uuid primary key default gen_random_uuid(),
  file_id uuid not null references project_files(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  version integer not null,
  storage_path text,
  uploaded_by text,
  file_size bigint,
  change_note text,
  created_at timestamptz not null default now()
);

create table if not exists project_activity (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  actor text not null,
  action text not null,
  item text not null,
  created_at timestamptz not null default now()
);

alter table workers enable row level security;
alter table time_entries enable row level security;
alter table folders enable row level security;
alter table project_files enable row level security;
alter table projects enable row level security;
alter table project_members enable row level security;
alter table project_file_versions enable row level security;
alter table project_activity enable row level security;

drop policy if exists workers_all_access on workers;
create policy workers_all_access on workers for all using (true) with check (true);

drop policy if exists time_entries_all_access on time_entries;
create policy time_entries_all_access on time_entries for all using (true) with check (true);

drop policy if exists folders_all_access on folders;
create policy folders_all_access on folders for all using (true) with check (true);

drop policy if exists project_files_all_access on project_files;
create policy project_files_all_access on project_files for all using (true) with check (true);

drop policy if exists projects_all_access on projects;
create policy projects_all_access on projects for all using (true) with check (true);

drop policy if exists project_members_all_access on project_members;
create policy project_members_all_access on project_members for all using (true) with check (true);

drop policy if exists project_file_versions_all_access on project_file_versions;
create policy project_file_versions_all_access on project_file_versions for all using (true) with check (true);

drop policy if exists project_activity_all_access on project_activity;
create policy project_activity_all_access on project_activity for all using (true) with check (true);
