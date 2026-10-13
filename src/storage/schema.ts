/**
 * Unified storage schema v2 (#2671, 6-OVERALL-DESIGN.md §schema; #2960 key change).
 *
 * Schema v2 delta (#2960 R2): sessions decompose their identity into REAL
 * columns PRIMARY KEY (agent, conv_id) instead of the single session_id column;
 * protocol/host/origin stay mutable metadata. Every child table keeps its single
 * session_id column but it now carries the opaque ESCAPED composite
 * makeSessionKey() value (see key.ts), so child tables need no second key column
 * and stay unambiguous when two agents share one conversation value. A v1→v2
 * migration rebuilds sessions (agent resolved from metadata_json) and re-keys
 * every child row inside one transaction.
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

import { makeSessionKey, resolveAgentNamespace } from "./key.js";

const STORAGE_SCHEMA_VERSION = 2;

export const STORAGE_PRAGMAS = [
    "PRAGMA journal_mode = WAL",
    "PRAGMA synchronous = NORMAL",
    "PRAGMA busy_timeout = 5000",
    "PRAGMA foreign_keys = ON",
] as const;

// #2960: PRIMARY KEY (agent, conv_id) — the identity pair as real columns
// (no in-value separator: node:sqlite truncates bound strings at NUL, so a
// composite string key is not engine-safe). `agent` is a birth-frozen fact
// (like created_at), never updated on re-ingest: ON CONFLICT in store.ts
// excludes it, so a later metadata drift cannot split a row's key.
const SESSIONS_COLUMNS_V2 = `
    agent               TEXT NOT NULL DEFAULT 'anon',
    conv_id             TEXT NOT NULL,
    parent_session_id   TEXT,
    fork_point_seq      INTEGER,
    protocol            TEXT,
    label               TEXT,
    title               TEXT,
    host_title          TEXT,
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
    ccr_json            TEXT`;

const SESSIONS_DDL_V2 = `
CREATE TABLE IF NOT EXISTS sessions (${SESSIONS_COLUMNS_V2},
    PRIMARY KEY (agent, conv_id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_conv ON sessions(conv_id);
`;

export const CHILDREN_DDL = `

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

interface MigrateDb {
    exec(sql: string): void;
    prepare(sql: string): {
        get(...a: unknown[]): unknown;
        all(...a: unknown[]): unknown[];
        run(...a: unknown[]): { changes: number };
    };
    transaction<T>(fn: () => T): T;
}

export interface MigrationReport {
    from: number;
    to: number;
    rekeyedSessions: number;
    /** Child rows whose v1 key matched no sessions row — left in place (data
     *  preservation over cleanup) and reported so an operator can inspect. */
    orphanedChildRows: number;
}

const CHILD_TABLES = ["messages", "blocks", "dead_refs", "refs", "checkpoints", "ccr_entries"] as const;

/** Applied inside one transaction whenever user_version < STORAGE_SCHEMA_VERSION. */
export function migrateSchema(db: MigrateDb): MigrationReport {
    const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
    const from = row?.user_version ?? 0;
    if (from >= STORAGE_SCHEMA_VERSION) return { from, to: from, rekeyedSessions: 0, orphanedChildRows: 0 };
    let rekeyed = 0;
    let orphaned = 0;
    db.transaction(() => {
        if (from < 1) {
            db.exec(SESSIONS_DDL_V2);
            db.exec(CHILDREN_DDL);
        } else {
            // #2960 v1→v2: rebuild sessions on the (agent, conv_id) pair and
            // rewrite every child row's opaque key. The old→new map is injective
            // (distinct v1 ids → distinct composites), so no collision is possible.
            db.exec(`CREATE TABLE sessions_v2_migration (${SESSIONS_COLUMNS_V2},
                PRIMARY KEY (agent, conv_id)
            )`);
            const rows = db.prepare("SELECT * FROM sessions").all() as Array<Record<string, unknown>>;
            const ins = db.prepare(`INSERT INTO sessions_v2_migration (
                agent, conv_id, parent_session_id, fork_point_seq, protocol, label, title, host_title,
                status, created_at, updated_at, next_block_id, next_run_id,
                meta_json, stats_json, metadata_json, kstate_json, tail_json, ccr_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
            const mapping: Array<[oldId: string, agent: string]> = [];
            for (const r of rows) {
                const oldId = String(r["session_id"]);
                let metadata: Record<string, unknown> | null = null;
                try {
                    const parsed: unknown = JSON.parse(String(r["metadata_json"] ?? "{}"));
                    if (parsed && typeof parsed === "object") metadata = parsed as Record<string, unknown>;
                } catch {
                    metadata = null;
                }
                const agent = resolveAgentNamespace(metadata);
                mapping.push([oldId, agent]);
                ins.run(
                    agent, oldId,
                    r["parent_session_id"], r["fork_point_seq"], r["protocol"], r["label"], r["title"], r["host_title"],
                    r["status"], Number(r["created_at"]), Number(r["updated_at"]),
                    Number(r["next_block_id"]), Number(r["next_run_id"]),
                    String(r["meta_json"]), String(r["stats_json"]), String(r["metadata_json"]),
                    String(r["kstate_json"]), String(r["tail_json"]),
                    r["ccr_json"] === null ? null : String(r["ccr_json"]),
                );
                rekeyed++;
            }
            db.exec("DROP TABLE sessions");
            db.exec("ALTER TABLE sessions_v2_migration RENAME TO sessions");
            db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_conv ON sessions(conv_id)");
            for (const t of CHILD_TABLES) {
                const total = Number((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
                let matched = 0;
                const upd = db.prepare(`UPDATE ${t} SET session_id = ? WHERE session_id = ?`);
                for (const [oldId, agent] of mapping) matched += Number(upd.run(makeSessionKey(agent, oldId), oldId).changes);
                orphaned += total - matched;
            }
        }
        db.exec(`PRAGMA user_version = ${STORAGE_SCHEMA_VERSION}`);
    });
    return { from, to: STORAGE_SCHEMA_VERSION, rekeyedSessions: rekeyed, orphanedChildRows: orphaned };
}
