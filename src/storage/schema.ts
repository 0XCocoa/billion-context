/**
 * Unified storage schema v1 (#2671, 6-OVERALL-DESIGN.md §schema).
 *
 * Principles encoded here:
 *  - messages/content/blocks are append-only facts (UPDATE is a bug; the
 *    only legal mutations are inserts and the documented active/supersedes
 *    transitions on blocks, plus refcount maintenance on content).
 *  - The compression ledger (blocks) is the crown jewel: every state change
 *    to it is one transaction.
 *  - Views are NEVER stored as content. Phase 1 does carry VIEW POINTERS
 *    (blocks.ord, sessions.tail_json) so the legacy load view can be
 *    reconstructed byte-exactly while the content itself lives once.
 *
 * Phase 1 representation discipline ("verbatim fact + verified projection"):
 *  - blocks.payload_json / messages.content / sessions.{meta,stats,metadata,
 *    kstate,ccr}_json hold the VERBATIM serialized facts (exact bytes the
 *    legacy reader would parse back).
 *  - Every scalar column is a PROJECTION extracted from those facts for
 *    querying. The dry-run verifier asserts projection == fact, so the
 *    columns cannot silently drift while reads still come from facts.
 *    Later phases flip readers to the projections one field at a time,
 *    guarded by the same assertions.
 *
 * Deltas from the public design sketch, all documented in the PR:
 *  - dead_refs table: tombstones are ledger family (kernel state carries
 *    them; #2370) — the sketch omitted them.
 *  - sessions.meta_json/stats_json/metadata_json/kstate_json/ccr_json and
 *    blocks.payload_json: single-column carry for kernel internals and
 *    legacy bags. One column = the #2388 "cloner drops a field" bug class
 *    is structurally impossible; column-level normalization is deferred
 *    until a consumer needs to query inside a bag.
 *  - content.bytes BLOB: chunks/ file extraction (open design question #6)
 *    is deferred — under a few GiB the single-file layout is simpler and
 *    keeps ingest atomic. `algo` names the digest; layout can move later.
 */

// v1: initial release shape (dev window) — sessions WITHOUT the identity
//        provenance columns.
// v2: identity registry (#2960/#2963) — sessions gains `namespace` and
//        `origin` (NULL-safe, constant defaults). Fresh databases create the
//        v2 shape directly; dev-window v1 databases upgrade in place via
//        idempotent ALTER TABLE (column presence probed first, so a dev
//        build that already carried the columns in its V1 DDL also lands
//        cleanly). §7.4: persisted-format changes are human-gated — this
//        bump is the review finding ② follow-up on merged #2815.
const STORAGE_SCHEMA_VERSION = 2;

export const STORAGE_PRAGMAS = [
    "PRAGMA journal_mode = WAL",
    "PRAGMA synchronous = NORMAL",
    "PRAGMA busy_timeout = 5000",
    "PRAGMA foreign_keys = ON",
] as const;

const STORAGE_DDL_V1 = `CREATE TABLE IF NOT EXISTS sessions (
    session_id          TEXT PRIMARY KEY,
    parent_session_id   TEXT,
    fork_point_seq      INTEGER,
    protocol            TEXT,
    label               TEXT,
    title               TEXT,
    host_title          TEXT,
    namespace           TEXT NOT NULL DEFAULT 'proxy',
    origin              TEXT,
    status              TEXT NOT NULL DEFAULT 'active',
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL,
    next_block_id       INTEGER NOT NULL DEFAULT 1,
    next_run_id         INTEGER NOT NULL DEFAULT 1,
    meta_json           TEXT NOT NULL DEFAULT '{}',
    stats_json          TEXT NOT NULL DEFAULT '{}',
    metadata_json       TEXT NOT NULL DEFAULT '{}',
    kstate_json         TEXT NOT NULL DEFAULT '{}',
    tail_json           TEXT NOT NULL DEFAULT '{}',
    ccr_json            TEXT
);

CREATE TABLE IF NOT EXISTS content (
    hash        TEXT PRIMARY KEY,
    byte_len    INTEGER NOT NULL,
    refcount    INTEGER NOT NULL DEFAULT 0,
    algo        TEXT NOT NULL DEFAULT 'sha256',
    bytes       BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
    session_id      TEXT NOT NULL,
    seq             INTEGER NOT NULL,
    msg_id          TEXT NOT NULL,
    ref             TEXT,
    ref_num         INTEGER,
    role            TEXT NOT NULL,
    kind            TEXT NOT NULL DEFAULT 'message',
    content_hash    TEXT NOT NULL REFERENCES content(hash),
    PRIMARY KEY (session_id, seq),
    UNIQUE (session_id, msg_id, content_hash)
);

CREATE TABLE IF NOT EXISTS blocks (
    block_id            TEXT NOT NULL,
    session_id          TEXT NOT NULL,
    ord                 INTEGER NOT NULL,
    start_seq           INTEGER NOT NULL,
    end_seq             INTEGER NOT NULL,
    start_ref           INTEGER,
    end_ref             INTEGER,
    tier                INTEGER NOT NULL,
    summary_hash        TEXT NOT NULL REFERENCES content(hash),
    one_hash            TEXT REFERENCES content(hash),
    supersedes_block_id TEXT,
    active              INTEGER NOT NULL DEFAULT 1,
    created_at          INTEGER NOT NULL,
    covered_hash        TEXT NOT NULL,
    payload_json        TEXT NOT NULL,
    PRIMARY KEY (session_id, block_id)
);

CREATE TABLE IF NOT EXISTS dead_refs (
    session_id      TEXT NOT NULL,
    ord             INTEGER NOT NULL,
    ref             TEXT NOT NULL,
    ref_num         INTEGER NOT NULL,
    recorded_at     INTEGER NOT NULL,
    PRIMARY KEY (session_id, ord)
);

-- Kernel ref ledger, verbatim: one row per messageRefs.byRaw entry, ord =
-- JSON key order of the persisted map. Dead refs (ghost ids with no message
-- row anywhere) live here forever — Kernel Contract: numbers are never
-- reused and death never removes the mapping (#2362/#2370).
CREATE TABLE IF NOT EXISTS refs (
    session_id      TEXT NOT NULL,
    ord             INTEGER NOT NULL,
    raw_id          TEXT NOT NULL,
    ref             TEXT NOT NULL,
    ref_num         INTEGER,
    PRIMARY KEY (session_id, ord),
    UNIQUE (session_id, raw_id)
);

CREATE TABLE IF NOT EXISTS checkpoints (
    cp_id           TEXT PRIMARY KEY,
    session_id      TEXT NOT NULL,
    seq_at          INTEGER NOT NULL,
    block_set_hash  TEXT NOT NULL,
    kind            TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    pinned          INTEGER NOT NULL DEFAULT 0,
    label           TEXT,
    -- Phase 2 (#2671): the full serialized session record this checkpoint
    -- freezes, in the content CAS. The row owns one refcount on the blob;
    -- pinned checkpoints therefore outlive deleteSession (GC protection).
    state_hash      TEXT NOT NULL REFERENCES content(hash)
);

CREATE TABLE IF NOT EXISTS ccr_entries (
    session_id      TEXT NOT NULL,
    ord             INTEGER NOT NULL,
    ccr_key         TEXT NOT NULL,
    content_hash    TEXT NOT NULL REFERENCES content(hash),
    PRIMARY KEY (session_id, ord)
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_msg_id ON messages(session_id, msg_id);
CREATE INDEX IF NOT EXISTS idx_blocks_session ON blocks(session_id, ord);
CREATE INDEX IF NOT EXISTS idx_dead_refs_session ON dead_refs(session_id, ord);
CREATE INDEX IF NOT EXISTS idx_refs_session ON refs(session_id, ord);
CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON checkpoints(session_id, created_at);
`;

/** Applied inside one transaction whenever user_version < STORAGE_SCHEMA_VERSION. */
export function migrateSchema(db: {
    exec(sql: string): void;
    prepare(sql: string): { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] };
    transaction<T>(fn: () => T): T;
}): { from: number; to: number } {
    const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
    const from = row?.user_version ?? 0;
    if (from >= STORAGE_SCHEMA_VERSION) return { from, to: from };
    db.transaction(() => {
        if (from < 1) db.exec(STORAGE_DDL_V1);
        if (from < 2) {
            // v2 identity columns — probe first: dev-window builds whose V1
            // DDL already carried them must not fail on duplicate columns.
            const cols = (db.prepare("PRAGMA table_info(sessions)").all() as unknown as { name?: unknown }[])
                .map((c) => (typeof c?.name === "string" ? c.name : ""));
            if (!cols.includes("namespace")) {
                db.exec("ALTER TABLE sessions ADD COLUMN namespace TEXT NOT NULL DEFAULT 'proxy'");
            }
            if (!cols.includes("origin")) {
                db.exec("ALTER TABLE sessions ADD COLUMN origin TEXT");
            }
        }
        db.exec(`PRAGMA user_version = ${STORAGE_SCHEMA_VERSION}`);
    });
    return { from, to: STORAGE_SCHEMA_VERSION };
}

/** Test-only alias of the fresh-install DDL (unused-export gate: INTERNAL_ONLY
 *  symbols fail CI; this one is consumed by tests/storage-unified.test.ts to
 *  synthesize faithful pre-#2963 v1 databases for the schema-v2 migration
 *  proof — the column set must track the real DDL, not a hand-copied stub). */
export const STORAGE_DDL_V1_FOR_TESTS = STORAGE_DDL_V1;
