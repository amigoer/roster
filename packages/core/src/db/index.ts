import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * node:sqlite rather than a native module: core is launched by Electron via
 * ELECTRON_RUN_AS_NODE, so a native build would need @electron/rebuild and a
 * per-platform prebuild matrix. Synchronous by design -- the append-only writer
 * is the one place where ordering must not interleave.
 */
/**
 * Columns added after a database already exists. CREATE TABLE IF NOT EXISTS
 * silently leaves old databases on the old shape, so every added column needs a
 * line here or it only exists on fresh installs.
 */
const ADDED_COLUMNS: Array<[table: string, column: string, ddl: string]> = [
  ["members", "resume_token", "TEXT"],
  ["bots", "title", "TEXT"],
  ["conversations", "leader_member_id", "TEXT"],
  ["members", "settings_json", "TEXT NOT NULL DEFAULT '{}'"],
  ["members", "session_json", "TEXT"],
  ["executors", "provider_ids_json", "TEXT NOT NULL DEFAULT '[]'"],
  ["executors", "rev", "INTEGER NOT NULL DEFAULT 1"],
  ["executors", "archived_at", "INTEGER"],
  ["bots", "model_source", "TEXT REFERENCES providers(id)"],
  ["providers", "rev", "INTEGER NOT NULL DEFAULT 1"],
];

const hasColumn = (db: DatabaseSync, table: string, column: string): boolean =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>).some((c) => c.name === column);

interface Migration {
  run(db: DatabaseSync): void;
  /** foreign_keys is a no-op inside a transaction, so a table rebuild has to switch it off around one */
  foreignKeysOff?: boolean;
  /** copy the database aside first, when this migration is about to rewrite something that cannot be undone */
  backup?: (db: DatabaseSync) => boolean;
}

/**
 * One-time data fixes, indexed by PRAGMA user_version. Unlike columns these
 * cannot be re-checked idempotently, so each runs exactly once -- except on a
 * fresh database, which starts at 0 and already has the current shape, so each
 * must also be a no-op there.
 */
const MIGRATIONS: Migration[] = [
  { run: (db) => {
    // Human lines used to skip the event log and take MAX(seq)+1 per
    // conversation; start the global sequence past them so new events sort after.
    // sqlite_sequence has no unique key on name, hence the read first.
    const { m: top } = db.prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM messages`).get() as unknown as {
      m: number;
    };
    const current = db.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'events'`).get() as unknown as
      | { seq: number }
      | undefined;
    if (!current && top > 0) {
      db.prepare(`INSERT INTO sqlite_sequence (name, seq) VALUES ('events', ?)`).run(top);
    } else if (current && current.seq < top) {
      db.prepare(`UPDATE sqlite_sequence SET seq = ? WHERE name = 'events'`).run(top);
    }
    // Existing members already hold their history in their own backend
    // session; 0 would now mean "owed the whole backlog".
    db.exec(`
      UPDATE members
         SET delivered_seq = (SELECT last_seq FROM conversations c WHERE c.id = members.conversation_id)
       WHERE delivered_seq = 0;
    `);
    // The old runtime ignored the snapshot and ran the live bot, so the live
    // bot is what these members have actually been running with.
    const executor = hasColumn(db, "bots", "backend") ? "backend" : "executor_id";
    db.exec(`
      UPDATE members
         SET spec_json = (SELECT json_object('name', b.name, 'system_prompt', b.system_prompt,
                                             '${executor}', b.${executor}, 'model', b.model)
                            FROM bots b WHERE b.id = members.bot_id);
    `);
  } },
  {
    // bots.backend carried CHECK (backend IN ('pi','claude')), which SQLite cannot
    // drop, so the table is rebuilt around executor_id. The two built-in executors
    // keep the old ids, so every stored value is already a valid executor.
    foreignKeysOff: true,
    backup: (db) => hasColumn(db, "bots", "backend"),
    run: (db) => {
      // a fresh database gets no executors: agents are installed as extensions, none is built in
      if (!hasColumn(db, "bots", "backend")) return;
      const t = Date.now();
      db.prepare(
        `INSERT OR IGNORE INTO executors (id, name, type, config_json, created_at, updated_at)
         VALUES ('claude', 'Claude Code', 'claude-code', '{}', ?, ?), ('pi', 'pi-agent', 'pi-agent', '{}', ?, ?)`,
      ).run(t, t, t, t);

      const count = (table: string) =>
        (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as unknown as { n: number }).n;
      const before = { bots: count("bots"), members: count("members") };
      // bots has no indexes or triggers of its own to carry across
      db.exec(`
        CREATE TABLE bots_rebuilt (
          id              TEXT PRIMARY KEY,
          name            TEXT NOT NULL,
          title           TEXT,
          avatar          TEXT,
          system_prompt   TEXT,
          executor_id     TEXT NOT NULL REFERENCES executors(id),
          model_source    TEXT REFERENCES providers(id),
          model           TEXT,
          permission_tier TEXT NOT NULL CHECK (permission_tier IN ('read', 'write', 'execute')),
          tools_json      TEXT NOT NULL DEFAULT '[]',
          created_at      INTEGER NOT NULL,
          updated_at      INTEGER NOT NULL,
          archived_at     INTEGER
        );
        INSERT INTO bots_rebuilt (id, name, title, avatar, system_prompt, executor_id, model_source, model,
                                  permission_tier, tools_json, created_at, updated_at, archived_at)
          SELECT id, name, title, avatar, system_prompt, backend, model_source, model,
                 permission_tier, tools_json, created_at, updated_at, archived_at
            FROM bots;
        DROP TABLE bots;
        PRAGMA legacy_alter_table = ON;
        ALTER TABLE bots_rebuilt RENAME TO bots;
        PRAGMA legacy_alter_table = OFF;
        UPDATE members
           SET spec_json = json_remove(json_set(spec_json, '$.executor_id', json_extract(spec_json, '$.backend')), '$.backend')
         WHERE json_extract(spec_json, '$.backend') IS NOT NULL;
      `);

      const dangling = db.prepare(`PRAGMA foreign_key_check`).all();
      if (dangling.length > 0) throw new Error(`executor migration left ${dangling.length} broken references`);
      const after = { bots: count("bots"), members: count("members") };
      if (after.bots !== before.bots || after.members !== before.members) {
        throw new Error(`executor migration lost rows: ${JSON.stringify({ before, after })}`);
      }
    },
  },
  {
    // Endpoints used to be bound to executors; now a bot names its own. A bot
    // on an executor that had one bound keeps running on that endpoint, the
    // first one where several were, which is what its sessions resolved to.
    run: (db) => {
      const rows = db.prepare(`SELECT id, provider_ids_json FROM executors`).all() as unknown as Array<{
        id: string;
        provider_ids_json: string;
      }>;
      for (const r of rows) {
        let ids: unknown;
        try {
          ids = JSON.parse(r.provider_ids_json || "[]");
        } catch {
          ids = [];
        }
        const first = Array.isArray(ids) ? ids.find((x) => typeof x === "string") : undefined;
        if (!first) continue;
        db.prepare(`UPDATE bots SET model_source = ? WHERE executor_id = ? AND model_source IS NULL`).run(first, r.id);
        db.prepare(
          `UPDATE members SET spec_json = json_set(spec_json, '$.model_source', ?)
            WHERE json_extract(spec_json, '$.executor_id') = ? AND json_extract(spec_json, '$.model_source') IS NULL`,
        ).run(first, r.id);
      }
    },
  },
];

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(readFileSync(join(here, "schema.sql"), "utf8"));

  for (const [table, column, ddl] of ADDED_COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{
      name: string;
    }>;
    if (cols.length > 0 && !cols.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
  }

  const { user_version: version } = db.prepare(`PRAGMA user_version`).get() as unknown as {
    user_version: number;
  };
  for (let v = version; v < MIGRATIONS.length; v++) {
    const migration = MIGRATIONS[v]!;
    if (migration.backup?.(db) && existsSync(path)) {
      // fold the WAL in first, or the copy misses whatever has not been checkpointed
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      copyFileSync(path, `${path}.bak-v${v + 1}`);
    }
    if (migration.foreignKeysOff) db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN");
    try {
      migration.run(db);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    } finally {
      if (migration.foreignKeysOff) db.exec("PRAGMA foreign_keys = ON");
    }
  }
  return db;
}
