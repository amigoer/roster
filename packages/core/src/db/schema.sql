-- events is the only source of truth. Everything else is a projection that
-- rebuildProjections() can regenerate by replay.

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

-- An agent: one harness type (Claude Code, pi-agent) bound to one model source.
-- Types are code and hold no state; executors are data, and a bot names one.
CREATE TABLE IF NOT EXISTS executors (
  id          TEXT PRIMARY KEY,
  -- what a person calls it; unique among live ones, shown wherever a bot's agent is
  name        TEXT NOT NULL,
  -- a harness type registered in code; deliberately no CHECK, or it is a closed list again
  type        TEXT NOT NULL,
  -- 'own' runs on the agent's own sign-in, 'endpoint' on the model API in provider_id
  source_kind TEXT NOT NULL DEFAULT 'own' CHECK (source_kind IN ('own', 'endpoint')),
  provider_id TEXT REFERENCES providers(id),
  -- what bots on it run when they name no model of their own
  model       TEXT,
  -- from before the program path belonged to the type; read only by the migration that moved it
  config_json TEXT NOT NULL DEFAULT '{}',
  -- from before bots named their own endpoint; read only by the migration that moved it
  provider_ids_json TEXT NOT NULL DEFAULT '[]',
  -- bumped when what it runs with changes; members snapshot it, so a change shows them as stale
  rev         INTEGER NOT NULL DEFAULT 1,
  -- 1 asks the model API to keep each session's prompt cache for an hour rather than minutes; not part of rev,
  -- since it applies to the next request without a new session
  long_cache  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  -- kept rather than deleted: archived bots and old members still point at it
  archived_at INTEGER
);

-- What this machine sets for a harness type. Keyed by type, so it cannot grow into a second instance.
CREATE TABLE IF NOT EXISTS harness_settings (
  type       TEXT PRIMARY KEY,
  -- the agent program to run; NULL runs the one found on the machine, then Roster's own install
  program    TEXT,
  updated_at INTEGER NOT NULL
);

-- What a person set for Roster as a whole, such as its language. Core writes text in it, so it lives here rather than in the UI.
CREATE TABLE IF NOT EXISTS preferences (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- A model endpoint and how to authenticate to it. An executor names one when it does not run on the agent's own sign-in.
CREATE TABLE IF NOT EXISTS providers (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  -- a preset a harness already knows (pi's "deepseek"), or 'custom' when base_url, api and models say it all
  preset       TEXT NOT NULL,
  api          TEXT,
  base_url     TEXT,
  -- the ids its API listed for a preset, refreshed by each check; the ones a person entered for 'custom'
  models_json  TEXT NOT NULL DEFAULT '[]',
  headers_json TEXT NOT NULL DEFAULT '{}',
  -- the key is in secrets, never here
  secret_ref   TEXT,
  -- or it is read from this environment variable and Roster keeps nothing
  key_env      TEXT,
  -- bumped when where it points or what it serves changes; members on it snapshot it
  rev          INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  archived_at  INTEGER
);

-- Provider keys at rest. Sealed with the desktop shell's key when there is one;
-- 'plain' otherwise, which the UI says out loud.
CREATE TABLE IF NOT EXISTS secrets (
  ref        TEXT PRIMARY KEY,
  alg        TEXT NOT NULL CHECK (alg IN ('aes-256-gcm', 'plain')),
  iv         BLOB,
  tag        BLOB,
  data       BLOB NOT NULL,
  -- the most the UI is ever shown of the value
  hint       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bots (
  id              TEXT PRIMARY KEY,
  -- unique among live bots, because @name is how a group addresses one
  name            TEXT NOT NULL,
  -- the one line under the name: what this bot is for
  title           TEXT,
  -- a logo id from the bundled set (src/logos.ts); every bot gets one
  avatar          TEXT,
  -- the preset, appended to the backend's own coding prompt
  system_prompt   TEXT,
  executor_id     TEXT NOT NULL REFERENCES executors(id),
  -- from before the executor named the source; read only by the migration that moved it
  model_source    TEXT REFERENCES providers(id),
  -- its own pick among its executor's models; NULL runs the executor's default
  model           TEXT,
  permission_tier TEXT NOT NULL CHECK (permission_tier IN ('read', 'write', 'execute')),
  tools_json      TEXT NOT NULL DEFAULT '[]',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  archived_at     INTEGER
);

CREATE TABLE IF NOT EXISTS conversations (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  -- presentation hint only; the runtime must never branch on it. A 1:1 is a
  -- one-member group, same code path.
  shape         TEXT NOT NULL CHECK (shape IN ('direct', 'group')),
  mode          TEXT NOT NULL DEFAULT 'human_led'
                CHECK (mode IN ('human_led', 'leader', 'discussion')),
  -- only read in leader mode; a stale value falls back to the first member
  leader_member_id TEXT,
  repo_path     TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  archived_at   INTEGER,

  -- projections
  last_seq         INTEGER NOT NULL DEFAULT 0,
  last_activity_at INTEGER NOT NULL,
  preview          TEXT,
  -- running is deliberately NOT an attention value: running never means unread.
  -- 'stalled' exists because a conversation wedged on a hung command is waiting
  -- for you while looking quiet, which is the worst failure mode of "quiet while working".
  attention        TEXT NOT NULL DEFAULT 'none'
                   CHECK (attention IN ('none', 'waiting_input', 'waiting_permission', 'error', 'stalled')),
  attention_since  INTEGER,
  run_state        TEXT NOT NULL DEFAULT 'idle' CHECK (run_state IN ('idle', 'running'))
);

CREATE INDEX IF NOT EXISTS idx_conv_sort
  ON conversations (archived_at, attention, attention_since, last_activity_at DESC);

CREATE TABLE IF NOT EXISTS members (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  bot_id          TEXT NOT NULL REFERENCES bots(id),
  -- snapshot of the bot at join time: bots are global and editable, and editing
  -- one must not mutate a running conversation underneath the user
  spec_json         TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  joined_at       INTEGER NOT NULL,
  left_at         INTEGER,
  -- how far this member has consumed the shared transcript; 0 means its
  -- backend context is empty and the backlog is owed on its next turn
  delivered_seq   INTEGER NOT NULL DEFAULT 0,
  -- the backend's own handle on this bot's context, so a restart resumes it
  resume_token    TEXT,
  -- model, effort and mode picked for this session; {} leaves them to the spec and the backend
  settings_json   TEXT NOT NULL DEFAULT '{}',
  -- the backend's last report of what the session runs with, shown before the next turn
  session_json    TEXT
);

CREATE INDEX IF NOT EXISTS idx_members_conv ON members (conversation_id, left_at);

CREATE TABLE IF NOT EXISTS events (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  member_id       TEXT REFERENCES members(id),
  turn_id         TEXT,
  type            TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  -- stored rather than re-derived: the transcript query and the peer-delivery
  -- query each become one indexed range scan, and a later rule change cannot
  -- silently rewrite history
  surface         INTEGER NOT NULL,
  broadcast       INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ev_conv      ON events (conversation_id, seq);
CREATE INDEX IF NOT EXISTS idx_ev_surface   ON events (conversation_id, surface, seq);
CREATE INDEX IF NOT EXISTS idx_ev_broadcast ON events (conversation_id, broadcast, seq);
CREATE INDEX IF NOT EXISTS idx_ev_turn      ON events (turn_id, seq);

-- Projection of surface=1. Exists so the transcript is one range scan for the
-- virtualized list, and so mutable cards (permission pending -> resolved, the
-- "ran N steps" counter) have a stable row to update in place.
CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  turn_id         TEXT,
  author_kind     TEXT NOT NULL CHECK (author_kind IN ('human', 'bot', 'system')),
  author_member_id TEXT,
  card_kind       TEXT NOT NULL
                  CHECK (card_kind IN ('text', 'steps', 'permission', 'artifact', 'system', 'error')),
  body_json       TEXT NOT NULL,
  status          TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages (conversation_id, seq);

CREATE TABLE IF NOT EXISTS artifacts (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  source_message_id TEXT,
  source_event_seq INTEGER NOT NULL,
  member_id        TEXT,
  kind             TEXT NOT NULL,
  title            TEXT NOT NULL,
  mime             TEXT NOT NULL,
  -- relative to the artifact store, not the worktree: worktrees get reset and
  -- deleted, so a pointer into one does not survive
  rel_path         TEXT NOT NULL,
  bytes            INTEGER,
  hidden           INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  deleted_at       INTEGER
);

CREATE INDEX IF NOT EXISTS idx_art_conv ON artifacts (conversation_id, created_at DESC);
