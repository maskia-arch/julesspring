-- 1. Erweiterung für Vektorsuche aktivieren
create extension if not exists vector;

-- 2. Tabelle für die Chats (Metadaten)
create table if not exists chats (
  id text primary key, -- Telegram Chat ID oder Web-Session ID
  platform text not null, -- 'telegram' oder 'web_widget'
  status text default 'ki' check (status in ('ki', 'manual')),
  metadata jsonb default '{}'::jsonb,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- 3. Tabelle für die Nachrichtenhistorie
create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  chat_id text references chats(id) on delete cascade,
  role text not null check (role in ('system', 'user', 'assistant')),
  content text not null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- 4. Tabelle für die Wissensdatenbank (RAG)
create table if not exists knowledge_base (
  id uuid primary key default gen_random_uuid(),
  content text not null,
  embedding vector(1536), -- 1536 für OpenAI 'text-embedding-3-small'
  source text, -- 'url' oder 'sellauth'
  external_id text unique, -- URL oder Produkt-ID
  metadata jsonb default '{}'::jsonb,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- 5. Tabelle für globale Einstellungen
create table if not exists settings (
  id int primary key default 1,
  system_prompt text not null default 'Du bist ein hilfreicher Assistent.',
  manual_msg_template text default 'Ein Mitarbeiter wird gleich übernehmen.',
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null,
  constraint one_row check (id = 1) -- Stellt sicher, dass es nur eine Einstellungszeile gibt
);

-- 6. Initialer Datensatz für Einstellungen
insert into settings (id, system_prompt) 
values (1, 'Du bist der offizielle Support-Bot. Antworte höflich und präzise.')
on conflict (id) do nothing;

-- 7. Log-Tabelle für Integrationen (Sellauth)
create table if not exists integration_logs (
  id uuid primary key default gen_random_uuid(),
  source text,
  event_type text,
  payload jsonb,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- 8. FUNKTION FÜR DIE VEKTORSUCHE (RPC)
-- Diese Funktion wird vom Backend aufgerufen, um relevante Textstellen zu finden.
create or replace function match_knowledge (
  query_embedding vector(1536),
  match_threshold float,
  match_count int
)
returns table (
  id uuid,
  content text,
  metadata jsonb,
  similarity float
)
language plpgsql
as $$
begin
  return query
  select
    knowledge_base.id,
    knowledge_base.content,
    knowledge_base.metadata,
    1 - (knowledge_base.embedding <=> query_embedding) as similarity
  from knowledge_base
  where 1 - (knowledge_base.embedding <=> query_embedding) > match_threshold
  order by similarity desc
  limit match_count;
end;
$$;
