-- 받아쓰기 웹앱(dictweb1) 전용 스키마 — 기존 프로젝트(phD, wdjovodhalidiqhlojvj) 안에서
-- 로봇 앱 데이터(research_* 테이블, research-session-packages 버킷)와 완전 분리하기 위해
-- dictweb_ 접두사 테이블과 dictweb-session-packages 버킷을 사용한다 (2026-08-28 사용자 확정).

create table if not exists public.dictweb_uploads (
  storage_path text primary key,
  storage_bucket text,
  package_name text,
  package_size_bytes bigint,
  status text,
  manifest_json jsonb,
  session_id text,
  participant_id text,
  class_id text,
  supabase_response_json jsonb,
  received_at timestamptz default now()
);

create table if not exists public.dictweb_participants (
  participant_id text primary key,
  class_id text,
  student_number_hash text,
  raw_json jsonb,
  ingested_at timestamptz default now()
);

create table if not exists public.dictweb_sessions (
  session_id text primary key,
  participant_id text,
  class_id text,
  class_group text,
  template_id text,
  judge_mode text,
  gate_pass_threshold int,
  verify_tau1 double precision,
  verify_tau2 double precision,
  verify_lambda double precision,
  started_at bigint,
  ended_at bigint,
  session_status text,
  app_version text,
  device_model text,
  raw_json jsonb,
  ingested_at timestamptz default now()
);
create index if not exists idx_dws_participant on public.dictweb_sessions(participant_id);

create table if not exists public.dictweb_attempts (
  note_attempt_id text primary key,
  session_id text,
  participant_id text,
  class_group text,
  template_id text,
  word_id text,
  target_word text,
  slot_index int,
  retry_index int,
  judge_mode text,
  judge_status text,
  is_blank boolean,
  blank_score double precision,
  ink_ratio double precision,
  gate_grade int,
  gate_score double precision,
  gate_decision text,
  gate_pass_threshold int,
  gate_model_version text,
  verify_margin double precision,
  verify_free_conf double precision,
  verify_completeness double precision,
  verify_best_margin double precision,
  verify_decision text,
  verify_tau1 double precision,
  verify_tau2 double precision,
  verify_lambda double precision,
  ocr_raw_text text,
  spelling_correct boolean,
  jamo_edit_distance int,
  wrong_jamo_positions jsonb,
  estimated_written text,
  reward_level int,
  escape_used boolean,
  feedback_message text,
  crop_asset_id text,
  crop_sha256 text,
  scan_duration_ms int,
  gate_duration_ms int,
  ocr_duration_ms int,
  created_at bigint,
  raw_json jsonb,
  ingested_at timestamptz default now()
);
create index if not exists idx_dwa_session on public.dictweb_attempts(session_id);
create index if not exists idx_dwa_participant on public.dictweb_attempts(participant_id);
create index if not exists idx_dwa_word on public.dictweb_attempts(word_id);

create table if not exists public.dictweb_events (
  event_id text primary key,
  session_id text,
  participant_id text,
  note_attempt_id text,
  event_type text,
  event_time bigint,
  local_sequence int,
  severity text,
  source text,
  message text,
  payload_json jsonb,
  raw_json jsonb,
  ingested_at timestamptz default now()
);
create index if not exists idx_dwe_session on public.dictweb_events(session_id);

create table if not exists public.dictweb_file_assets (
  file_asset_id text primary key,
  session_id text,
  note_attempt_id text,
  asset_type text,
  storage_bucket text,
  storage_path text,
  mime_type text,
  file_size_bytes bigint,
  sha256 text,
  width int,
  height int,
  slot_index int,
  raw_json jsonb,
  ingested_at timestamptz default now()
);
create index if not exists idx_dwf_session on public.dictweb_file_assets(session_id);

alter table public.dictweb_uploads enable row level security;
alter table public.dictweb_participants enable row level security;
alter table public.dictweb_sessions enable row level security;
alter table public.dictweb_attempts enable row level security;
alter table public.dictweb_events enable row level security;
alter table public.dictweb_file_assets enable row level security;

insert into storage.buckets (id, name, public)
values ('dictweb-session-packages', 'dictweb-session-packages', false)
on conflict (id) do nothing;
