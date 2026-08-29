/**
 * SQLite-backed card store.
 *
 * The JSON store this replaces rewrote every card — embeddings included — on
 * every single mutation, and copied the whole file to a backup first. Editing
 * one card cost two passes over the entire database, which grows with both the
 * card count and the embedding width.
 *
 * The working set still lives in memory as plain arrays, because the rest of
 * the API reasons about cards that way and a personal cabinet fits comfortably.
 * What changed is writing: only the rows you touched, inside a transaction.
 *
 * Vectors are stored as float32 blobs — the same precision Postgres uses for
 * `vector`, and a quarter of the bytes of the JSON text they replace.
 */

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const STORE_VERSION = 3;
const MAX_BACKUPS = 10;

/**
 * Where the understanding on a card came from.
 *
 * A card is a cache entry; these are its origin. The plain `source` string is
 * kept and still shown, because it is what someone wrote and the point is not
 * to make them rewrite it — these sit beside it, all nullable, all absent on
 * every card that existed before them (CLAUDE.md §3.18).
 */
const SOURCE_COLUMNS = [
  "source_type", "source_title", "source_url", "source_external_id",
  "source_updated_at", "source_content_hash", "source_checked_at",
];

const CARD_COLUMNS = [
  "id", "number", "topic", "category", "title", "question", "summary",
  "analogy", "detail", "source", "tags", "cover", "embedding", "embedding_dims",
  "embedding_model_id", "embedding_source_hash", "created_at", "updated_at", "deleted_at",
  ...SOURCE_COLUMNS,
];

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)",
  `CREATE TABLE IF NOT EXISTS cards (
     id TEXT PRIMARY KEY,
     number TEXT NOT NULL DEFAULT '',
     topic TEXT NOT NULL DEFAULT '',
     category TEXT NOT NULL DEFAULT '',
     title TEXT NOT NULL DEFAULT '',
     question TEXT NOT NULL DEFAULT '',
     summary TEXT NOT NULL DEFAULT '',
     analogy TEXT NOT NULL DEFAULT '',
     detail TEXT NOT NULL DEFAULT '',
     source TEXT NOT NULL DEFAULT '',
     tags TEXT NOT NULL DEFAULT '[]',
     cover TEXT,
     embedding BLOB,
     embedding_dims INTEGER,
     embedding_model_id TEXT,
     embedding_source_hash TEXT,
     created_at TEXT,
     updated_at TEXT,
     deleted_at TEXT,
     source_type TEXT,
     source_title TEXT,
     source_url TEXT,
     source_external_id TEXT,
     source_updated_at TEXT,
     source_content_hash TEXT,
     source_checked_at TEXT
   )`,
  "CREATE INDEX IF NOT EXISTS cards_deleted_at_idx ON cards (deleted_at)",
  "CREATE INDEX IF NOT EXISTS cards_category_idx ON cards (category)",
  `CREATE TABLE IF NOT EXISTS relations (
     source_id TEXT NOT NULL,
     target_id TEXT NOT NULL,
     relation_type TEXT NOT NULL,
     score REAL NOT NULL DEFAULT 0,
     status TEXT NOT NULL DEFAULT 'suggested',
     created_at TEXT,
     updated_at TEXT,
     PRIMARY KEY (source_id, target_id, relation_type)
   )`,
  // Relations are looked up from either end, so the target needs its own index.
  "CREATE INDEX IF NOT EXISTS relations_target_idx ON relations (target_id)",
  "CREATE TABLE IF NOT EXISTS categories (name TEXT PRIMARY KEY, position INTEGER NOT NULL DEFAULT 0)",
];

function readJsonMeta(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** float32 matches Postgres `vector` — same precision, a quarter of JSON's bytes. */
function encodeVector(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  return Buffer.from(new Float32Array(values).buffer);
}

function decodeVector(blob) {
  if (!blob || blob.byteLength < 4) return null;
  const bytes = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return Array.from(new Float32Array(copy.buffer));
}

function parseJson(value, fallback) {
  if (typeof value !== "string" || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function rowToCard(row) {
  return {
    id: row.id,
    number: row.number,
    topic: row.topic,
    category: row.category,
    title: row.title,
    question: row.question,
    summary: row.summary,
    analogy: row.analogy,
    detail: row.detail,
    source: row.source,
    tags: parseJson(row.tags, []),
    cover: parseJson(row.cover, null),
    embedding: decodeVector(row.embedding),
    embedding_model_id: row.embedding_model_id ?? null,
    embedding_source_hash: row.embedding_source_hash ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
    deleted_at: row.deleted_at ?? null,
    ...Object.fromEntries(SOURCE_COLUMNS.map((column) => [column, row[column] ?? null])),
  };
}

function cardToRow(card) {
  const embedding = encodeVector(card.embedding);
  return [
    String(card.id ?? ""),
    String(card.number ?? ""),
    String(card.topic ?? ""),
    String(card.category ?? ""),
    String(card.title ?? ""),
    String(card.question ?? ""),
    String(card.summary ?? ""),
    String(card.analogy ?? ""),
    String(card.detail ?? ""),
    String(card.source ?? ""),
    JSON.stringify(Array.isArray(card.tags) ? card.tags : []),
    card.cover ? JSON.stringify(card.cover) : null,
    embedding,
    embedding ? embedding.byteLength / 4 : null,
    card.embedding_model_id ?? null,
    card.embedding_source_hash ?? null,
    card.created_at ?? null,
    card.updated_at ?? null,
    card.deleted_at ?? null,
    ...SOURCE_COLUMNS.map((column) => card[column] ?? null),
  ];
}

/**
 * Open (creating if needed) the SQLite store beside `dataFile`.
 *
 * `dataFile` stays the historical cards.json path so callers do not change;
 * when a JSON store exists and the database does not, its contents are adopted
 * once and the JSON file is left untouched as a fallback.
 */
function openStore(dataFile) {
  const directory = path.dirname(dataFile);
  const databaseFile = path.join(directory, "cards.db");
  fs.mkdirSync(directory, { recursive: true });

  const database = new DatabaseSync(databaseFile);
  // WAL keeps readers off the writer's back and turns each commit into an
  // append — which matters on the SD card a Raspberry Pi boots from.
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA synchronous = NORMAL");
  for (const statement of SCHEMA) database.exec(statement);
  // CREATE TABLE IF NOT EXISTS does nothing to a table that already exists, so
  // a store opened before these columns were added would keep answering
  // "no such column" forever — a fresh install would work and every existing
  // one would not. Adding a nullable column is the whole migration: SQLite
  // rewrites no rows and every card that predates it reads back as null.
  const present = new Set(database.prepare("PRAGMA table_info(cards)").all().map((row) => row.name));
  for (const column of SOURCE_COLUMNS) {
    if (!present.has(column)) database.exec(`ALTER TABLE cards ADD COLUMN ${column} TEXT`);
  }

  const insertCard = database.prepare(
    `INSERT INTO cards (${CARD_COLUMNS.join(", ")}) VALUES (${CARD_COLUMNS.map(() => "?").join(", ")})
     ON CONFLICT(id) DO UPDATE SET ${CARD_COLUMNS.filter((column) => column !== "id").map((column) => `${column} = excluded.${column}`).join(", ")}`,
  );
  const deleteCard = database.prepare("DELETE FROM cards WHERE id = ?");
  const insertRelation = database.prepare(
    `INSERT INTO relations (source_id, target_id, relation_type, score, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_id, target_id, relation_type) DO UPDATE SET
       score = excluded.score, status = excluded.status, updated_at = excluded.updated_at`,
  );
  const insertCategory = database.prepare("INSERT OR REPLACE INTO categories (name, position) VALUES (?, ?)");
  const insertMeta = database.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");

  const transaction = (work) => {
    database.exec("BEGIN");
    try {
      work();
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

  function readMeta() {
    const rows = database.prepare("SELECT key, value FROM meta").all();
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }

  function load() {
    const meta = readMeta();
    return {
      version: Number(meta.version || STORE_VERSION),
      cards: database.prepare("SELECT * FROM cards").all().map(rowToCard),
      relations: database.prepare("SELECT * FROM relations").all().map((row) => ({
        source_id: row.source_id,
        target_id: row.target_id,
        relation_type: row.relation_type,
        score: row.score,
        status: row.status,
        created_at: row.created_at ?? null,
        updated_at: row.updated_at ?? null,
      })),
      categories: database.prepare("SELECT name FROM categories ORDER BY position, name").all().map((row) => row.name),
      // Which accent each category was given. Kept because the assignment is
      // made once and must not move afterwards — a card's colour is part of how
      // it is recognised, so it cannot be recomputed from the current category
      // list and shift every time a category is added or deleted.
      category_accents: readJsonMeta(meta.category_accents),
      embedding_model_id: meta.embedding_model_id ?? "embedding-hash-384",
      summary_model_id: meta.summary_model_id ?? "summary-template",
    };
  }

  const writeMeta = (store) => {
    insertMeta.run("version", String(store.version ?? STORE_VERSION));
    insertMeta.run("embedding_model_id", String(store.embedding_model_id ?? ""));
    insertMeta.run("summary_model_id", String(store.summary_model_id ?? ""));
    insertMeta.run("category_accents", JSON.stringify(store.category_accents ?? {}));
  };

  const writeCards = (store, ids) => {
    // null/undefined means "every card"; an empty list means "none of them",
    // which is what a relation-only or purge-only change needs.
    const wanted = ids == null ? null : new Set(ids);
    const present = new Set();
    for (const card of store.cards) {
      present.add(card.id);
      if (wanted === null || wanted.has(card.id)) insertCard.run(...cardToRow(card));
    }
    // A card that left the working set was purged; drop it here too.
    for (const row of database.prepare("SELECT id FROM cards").all()) {
      if (!present.has(row.id)) deleteCard.run(row.id);
    }
  };

  const writeRelations = (store) => {
    // Relations are recomputed wholesale by the rebuild passes and carry no
    // vectors, so replacing the table is both simpler and cheap.
    database.exec("DELETE FROM relations");
    for (const relation of store.relations) {
      insertRelation.run(
        relation.source_id, relation.target_id, relation.relation_type,
        Number(relation.score ?? 0), String(relation.status ?? "suggested"),
        relation.created_at ?? null, relation.updated_at ?? null,
      );
    }
  };

  const writeCategories = (store) => {
    database.exec("DELETE FROM categories");
    (store.categories || []).forEach((name, position) => insertCategory.run(String(name), position));
  };

  return {
    databaseFile,
    load,

    /**
     * Persist a change.
     *
     * `cards` names the cards that were touched; omitting it rewrites them all,
     * which is correct but is the thing this store exists to avoid — pass the
     * ids whenever the caller knows them.
     */
    save(store, { cards = null, relations = true, categories = true, meta = true } = {}) {
      transaction(() => {
        writeCards(store, cards);
        if (relations) writeRelations(store);
        if (categories) writeCategories(store);
        if (meta) writeMeta(store);
      });
    },

    /** Adopt a whole store, replacing everything. Used by import and reset. */
    replaceAll(store) {
      transaction(() => {
        database.exec("DELETE FROM cards");
        database.exec("DELETE FROM relations");
        database.exec("DELETE FROM categories");
        for (const card of store.cards) insertCard.run(...cardToRow(card));
        writeRelations(store);
        writeCategories(store);
        writeMeta(store);
      });
    },

    isEmpty() {
      return database.prepare("SELECT COUNT(*) AS count FROM cards").get().count === 0;
    },

    /**
     * The embedding width this store already holds, or 0 when it holds none.
     *
     * Taken from the cards themselves rather than a recorded setting, because
     * the cards are the thing that has to stay internally consistent — the most
     * common width wins so a few stragglers awaiting reindex do not redefine it.
     */
    storedDimensions() {
      const row = database.prepare(
        `SELECT embedding_dims AS dims, COUNT(*) AS count FROM cards
         WHERE embedding_dims IS NOT NULL AND deleted_at IS NULL
         GROUP BY embedding_dims ORDER BY count DESC LIMIT 1`,
      ).get();
      return row ? Number(row.dims) : 0;
    },

    close() {
      database.close();
    },
  };
}

/**
 * Write a rotated JSON snapshot before a destructive operation.
 *
 * The old JSON store copied itself on every write, which made backups a side
 * effect of saving; now they are deliberate, and they hold the same checksummed
 * export format the API hands out — so a backup can be fed straight back in.
 */
function writeBackup(dataFile, payload, reason = "auto") {
  const backupDir = path.join(path.dirname(dataFile), "backups");
  try {
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[.:]/gu, "-");
    const target = path.join(backupDir, `cards-${stamp}-${reason}.json`);
    fs.writeFileSync(target, JSON.stringify(payload, null, 2), "utf8");

    const backups = fs.readdirSync(backupDir)
      .filter((name) => name.startsWith("cards-") && name.endsWith(".json"))
      .map((name) => path.join(backupDir, name))
      .sort((first, second) => fs.statSync(second).mtimeMs - fs.statSync(first).mtimeMs);
    for (const stale of backups.slice(MAX_BACKUPS)) fs.rmSync(stale, { force: true });
    return target;
  } catch {
    // A backup that cannot be written must not block the operation itself.
    return null;
  }
}

module.exports = { openStore, writeBackup, encodeVector, decodeVector, STORE_VERSION };
