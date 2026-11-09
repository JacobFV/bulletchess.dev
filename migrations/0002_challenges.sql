-- Challenges: on-demand or scheduled, to a specific player (to_id) or to anyone (to_id NULL).
CREATE TABLE challenges (
  id TEXT PRIMARY KEY NOT NULL,
  from_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  to_id TEXT REFERENCES user(id) ON DELETE CASCADE,
  accepted_by TEXT REFERENCES user(id) ON DELETE CASCADE,
  base INTEGER NOT NULL,
  inc INTEGER NOT NULL,
  rated INTEGER NOT NULL,
  color TEXT NOT NULL,
  -- pending → accepted (scheduled only) → started; or declined / cancelled / expired
  status TEXT NOT NULL,
  scheduled_at INTEGER,
  expires_at INTEGER NOT NULL,
  game_id TEXT,
  reminded INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX challenges_to_idx ON challenges(to_id, status);
CREATE INDEX challenges_from_idx ON challenges(from_id, status);
CREATE INDEX challenges_accepted_idx ON challenges(accepted_by, status);
CREATE INDEX challenges_open_idx ON challenges(status, to_id, expires_at);
CREATE INDEX challenges_sched_idx ON challenges(status, scheduled_at);

-- Per-user server-side preferences.
CREATE TABLE user_prefs (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  challenges TEXT NOT NULL DEFAULT 'everyone', -- everyone | nobody
  updated_at INTEGER NOT NULL
);
