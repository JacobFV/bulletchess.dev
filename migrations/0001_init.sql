-- Better Auth core tables (+ username plugin columns)
CREATE TABLE user (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  username TEXT UNIQUE,
  display_username TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE session (
  id TEXT PRIMARY KEY NOT NULL,
  expires_at INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE
);
CREATE INDEX session_user_idx ON session(user_id);

CREATE TABLE account (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  access_token TEXT,
  refresh_token TEXT,
  id_token TEXT,
  access_token_expires_at INTEGER,
  refresh_token_expires_at INTEGER,
  scope TEXT,
  password TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX account_user_idx ON account(user_id);
CREATE UNIQUE INDEX account_provider_uq ON account(provider_id, account_id);

CREATE TABLE verification (
  id TEXT PRIMARY KEY NOT NULL,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER,
  updated_at INTEGER
);
CREATE INDEX verification_identifier_idx ON verification(identifier);

CREATE TABLE rate_limit (
  id TEXT PRIMARY KEY NOT NULL,
  key TEXT NOT NULL UNIQUE,
  count INTEGER NOT NULL,
  last_request INTEGER NOT NULL
);

-- Ratings: one Glicko-2 rating per user per perf.
CREATE TABLE ratings (
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  perf TEXT NOT NULL,
  rating REAL NOT NULL,
  rd REAL NOT NULL,
  vol REAL NOT NULL,
  games INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  draws INTEGER NOT NULL DEFAULT 0,
  best REAL,
  last_played_at INTEGER,
  PRIMARY KEY (user_id, perf)
);
CREATE INDEX ratings_leader_idx ON ratings(perf, rating DESC);

CREATE TABLE rating_history (
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  perf TEXT NOT NULL,
  game_id TEXT NOT NULL,
  rating REAL NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX rating_history_user_idx ON rating_history(user_id, perf, at);

-- Finished games (live games live in their Durable Object until they end).
CREATE TABLE games (
  id TEXT PRIMARY KEY NOT NULL,
  white_id TEXT REFERENCES user(id) ON DELETE SET NULL,
  black_id TEXT REFERENCES user(id) ON DELETE SET NULL,
  white_name TEXT NOT NULL,
  black_name TEXT NOT NULL,
  white_rating INTEGER,
  black_rating INTEGER,
  white_diff INTEGER,
  black_diff INTEGER,
  rated INTEGER NOT NULL DEFAULT 0,
  perf TEXT NOT NULL,
  base INTEGER NOT NULL,
  inc INTEGER NOT NULL,
  source TEXT NOT NULL,
  bot_level INTEGER,
  status TEXT NOT NULL,
  winner TEXT,
  moves TEXT NOT NULL DEFAULT '',
  sans TEXT NOT NULL DEFAULT '',
  clocks TEXT NOT NULL DEFAULT '',
  final_fen TEXT NOT NULL,
  ply INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL
);
CREATE INDEX games_white_idx ON games(white_id, ended_at DESC);
CREATE INDEX games_black_idx ON games(black_id, ended_at DESC);
CREATE INDEX games_recent_idx ON games(ended_at DESC);
