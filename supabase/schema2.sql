-- Tabelle für gesperrte Nutzer (Hard-Ban)
create table if not exists blacklist (
  id uuid primary key default gen_random_uuid(),
  identifier text unique, -- Kann Telegram-ID, IP oder Browser-Fingerprint sein
  reason text,
  created_at timestamp with time zone default now()
);

-- Warteschlange für den Learning-Chat (KI an Admin)
create table if not exists learning_queue (
  id uuid primary key default gen_random_uuid(),
  original_chat_id text,
  unanswered_question text,
  status text default 'pending', -- 'pending', 'resolved'
  created_at timestamp with time zone default now()
);

-- Speichert Browser-Push-Abonnements des Admins
create table if not exists admin_subscriptions (
  id uuid primary key default gen_random_uuid(),
  subscription_data jsonb not null,
  created_at timestamp with time zone default now()
);

-- Erweitert die Chats-Tabelle um ein Flag für den Learning-Modus
alter table chats add column if not exists is_learning_session boolean default false;
