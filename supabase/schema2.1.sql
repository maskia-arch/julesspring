-- Aktiviert die Vektor-Erweiterung (falls noch nicht geschehen)
create extension if not exists vector;

-- Erstellt die Tabelle für das Wissen (falls noch nicht geschehen)
create table if not exists knowledge_base (
  id uuid primary key default uuid_generate_v4(),
  content text,
  source text,
  metadata jsonb,
  embedding vector(1536), -- 1536 ist die Standardgröße für OpenAI Embeddings
  created_at timestamp with time zone default timezone('utc'::text, now())
);
