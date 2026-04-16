-- schema_v17.sql  ──  Per-Channel Smalltalk KB + System Prompts

-- Channel-eigene Wissensdatenbank (isoliert vom Berater)
CREATE TABLE IF NOT EXISTS channel_knowledge (
  id           BIGSERIAL PRIMARY KEY,
  channel_id   BIGINT NOT NULL REFERENCES bot_channels(id) ON DELETE CASCADE,
  category     TEXT NOT NULL DEFAULT 'allgemein',  -- frei vergebbar pro Channel
  title        TEXT,
  content      TEXT NOT NULL,
  embedding    vector(1536),
  source       TEXT DEFAULT 'manual',
  metadata     JSONB DEFAULT '{}',
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_channel_knowledge_channel ON channel_knowledge(channel_id);
CREATE INDEX IF NOT EXISTS idx_channel_knowledge_embedding ON channel_knowledge 
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);

-- System-Prompt + KB-Status pro Channel
ALTER TABLE bot_channels ADD COLUMN IF NOT EXISTS system_prompt   TEXT;
ALTER TABLE bot_channels ADD COLUMN IF NOT EXISTS kb_initialized  BOOLEAN DEFAULT false;
ALTER TABLE bot_channels ADD COLUMN IF NOT EXISTS kb_entry_count  INTEGER DEFAULT 0;

-- RPC: Channel-KB semantisch suchen
CREATE OR REPLACE FUNCTION match_channel_knowledge(
  p_channel_id   BIGINT,
  query_embedding vector(1536),
  match_threshold FLOAT  DEFAULT 0.50,
  match_count     INT    DEFAULT 4
)
RETURNS TABLE (id BIGINT, category TEXT, title TEXT, content TEXT, similarity FLOAT)
LANGUAGE sql STABLE AS $$
  SELECT id, category, title, content,
         1 - (embedding <=> query_embedding) AS similarity
  FROM channel_knowledge
  WHERE channel_id = p_channel_id
    AND 1 - (embedding <=> query_embedding) > match_threshold
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;
