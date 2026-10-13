/**
 * Identity-key contract (#2960): unified-store sessions are keyed by the PAIR
 * (agent namespace, conversation id); protocol/host/origin stay mutable
 * metadata. Pins:
 *
 *   KEY HELPERS      — escaped composite mint/parse round-trip (ids may contain
 *                      the separator or the escape char), bare-key fallback,
 *                      NUL guards, length cap, agent resolution precedence.
 *   V1→V2 MIGRATION  — a hand-built schema-v1 index.db rekeys in place on
 *                      open: sessions rebuild on (agent, conv_id), children
 *                      follow into escaped composites, orphans are preserved
 *                      and reported, user_version=2.
 *   COLLISION        — two agents sharing one conversation id get two rows;
 *                      hintless lookups resolve deterministically (newest
 *                      updated_at) while exact-key lookups never mix.
 *   BIRTH FREEZE     — re-ingest under the same (agent, id) updates mutable
 *                      columns only; a different agent mints a sibling row
 *                      and never touches the original.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ANON_AGENT, SESSION_KEY_SEP, isSessionKey, makeSessionKey, parseSessionKey, resolveAgentNamespace } from "../src/storage/key.ts";
import { UnifiedStore } from "../src/storage/store.ts";
import { CHILDREN_DDL } from "../src/storage/schema.ts";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import { rmrf } from "./tmp-rm.ts";

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_CONFIG_FILE = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "bili-key-hermetic-")),
    "no-config.json",
);
delete process.env.BILI_STORAGE_UNIFIED;

function tmpdir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Schema-v1 sessions table, verbatim pre-#2960 shape (single-column PK, no
// agent column) — the migration input fixture.
const V1_SESSIONS_DDL = `
CREATE TABLE IF NOT EXISTS sessions (
    session_id          TEXT PRIMARY KEY,
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
    ccr_json            TEXT
);
`;

test("key helpers: mint/parse round-trip, guards, caps", () => {
    const rt = parseSessionKey(makeSessionKey("dsh", "conv-123"));
    assert.deepEqual(rt, { agent: "dsh", convId: "conv-123" });

    // Ids are opaque: separator and escape chars inside EITHER half must
    // survive the round-trip exactly.
    const tricky = parseSessionKey(makeSessionKey("ag|ent", "con\\|v|pipe"));
    assert.deepEqual(tricky, { agent: "ag|ent", convId: "con\\|v|pipe" });
    assert.ok(isSessionKey(makeSessionKey("a", "b")));
    assert.ok(!isSessionKey("plain-old-id"));
    assert.ok(!isSessionKey("escaped\\|only"));

    // Pre-v2 bare keys read back as anon-owned, content intact.
    assert.deepEqual(parseSessionKey("plain-old-id"), { agent: ANON_AGENT, convId: "plain-old-id" });

    // NULs cannot survive a node:sqlite bind (it truncates there) — they are
    // lossy-replaced before any string ever reaches the driver.
    const nulled = parseSessionKey(makeSessionKey("ag\u0000ent", "con\u0000v"));
    assert.equal(nulled.agent, "ag\uFFFDent");
    assert.equal(nulled.convId, "con\uFFFDv");
    assert.ok(!nulled.agent.includes("\u0000"));

    // Agent half is capped at exactly 64 chars; the conversation half is
    // opaque and unbounded.
    const longAgent = parseSessionKey(makeSessionKey("a".repeat(128), "x"));
    assert.equal(longAgent.agent.length, 64);
    assert.equal(longAgent.convId, "x");
});

test("key helpers: agent namespace resolution precedence", () => {
    assert.equal(resolveAgentNamespace({ pluginAgent: "dsh", clientHint: "pi" }), "dsh");
    assert.equal(resolveAgentNamespace({ clientHint: "pi" }), "pi");
    assert.equal(resolveAgentNamespace({ pluginAgent: 123, clientHint: "pi" }), "pi");
    assert.equal(resolveAgentNamespace({ pluginAgent: "   ", clientHint: "pi" }), "pi");
    assert.equal(resolveAgentNamespace({ pluginAgent: "dsh" }), "dsh");
    assert.equal(resolveAgentNamespace({}), ANON_AGENT);
    assert.equal(resolveAgentNamespace(undefined), ANON_AGENT);
    assert.equal(resolveAgentNamespace(null), ANON_AGENT);
});

test("migration: schema-v1 index.db rekeys in place to (agent, conv_id)", () => {
    const dir = tmpdir("bili-key-migration-");
    try {
        const dbPath = path.join(dir, "index.db");
        const { db: raw } = openSqliteDatabase(dbPath);
        try {
            raw.exec(V1_SESSIONS_DDL);
            raw.exec(CHILDREN_DDL);
            raw.prepare("INSERT INTO content (hash, byte_len, refcount, algo, bytes) VALUES (?, ?, ?, ?, ?)")
                .run("h1", 5, 1, "sha256", Buffer.from("hello"));
            raw.prepare(
                "INSERT INTO sessions (session_id, parent_session_id, fork_point_seq, protocol, label, title, host_title, status, created_at, updated_at, next_block_id, next_run_id, meta_json, stats_json, metadata_json, kstate_json, tail_json, ccr_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ).run("conv-x", null, null, "anthropic", null, null, null, "active", 4_999, 5_000, 1, 1, "{}", "{}", '{"pluginAgent":"dsh"}', "{}", "{}", null);
            raw.prepare(
                "INSERT INTO sessions (session_id, parent_session_id, fork_point_seq, protocol, label, title, host_title, status, created_at, updated_at, next_block_id, next_run_id, meta_json, stats_json, metadata_json, kstate_json, tail_json, ccr_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ).run("conv-y", null, null, "chat", null, null, null, "active", 4_999, 5_000, 1, 1, "{}", "{}", "{}", "{}", "{}", null);
            raw.prepare("INSERT INTO messages (session_id, seq, msg_id, ref, ref_num, role, kind, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
                .run("conv-x", 1, "raw1", null, null, "user", "message", "h1");
            // Orphan child row: no sessions row ever owned this id.
            raw.prepare("INSERT INTO refs (session_id, ord, raw_id, ref, ref_num) VALUES (?, ?, ?, ?, ?)")
                .run("ghost", 0, "g1", "m00001", null);
            raw.exec("PRAGMA user_version = 1");
        } finally {
            raw.close();
        }

        const store = UnifiedStore.open(dbPath);
        try {
            // The hinted (exact pair) lookup finds the dsh-owned rebuild.
            const rowX = store.getSessionRow(makeSessionKey("dsh", "conv-x"));
            assert.ok(rowX, "hinted v1 row must rekey under its derived agent");
            assert.equal(rowX!.agent, "dsh");
            assert.equal(rowX!.sessionId, "conv-x");
            assert.equal(rowX!.protocol, "anthropic");

            // No-hint rows fall back to anon.
            const rowY = store.getSessionRow(makeSessionKey(ANON_AGENT, "conv-y"));
            assert.ok(rowY, "unhinted v1 row must rekey under anon");
            assert.equal(rowY!.agent, ANON_AGENT);

            // Children followed their session into the escaped composite key —
            // reachable both by exact key and by bare-id resolution.
            assert.equal(store.getMessages(makeSessionKey("dsh", "conv-x")).length, 1);
            assert.equal(store.getMessages("conv-x").length, 1);
            assert.equal(store.getMessages("conv-x")[0].msgId, "raw1");

            const { db: probe } = openSqliteDatabase(dbPath);
            try {
                // Orphans were left IN PLACE (data preservation over cleanup) —
                // checked at the table level: the API deliberately serves
                // children only under a live sessions row.
                assert.equal(
                    Number((probe.prepare("SELECT COUNT(*) AS n FROM refs WHERE session_id = 'ghost'").get() as { n: number }).n),
                    1,
                );
                const r = probe.prepare("PRAGMA user_version").get() as { user_version: number };
                assert.equal(r.user_version, 2);
            } finally {
                probe.close();
            }
        } finally {
            store.close();
        }
    } finally {
        rmrf(dir);
    }
});

/** Minimal message-bearing record for key-shape tests. */
function mkRecord(id: string, metadata: Record<string, unknown>, lastSeen: number, protocol = "openai"): LegacySessionLike {
    return {
        id,
        createdAt: 1_000,
        lastSeen,
        meta: { protocol },
        stats: { requests: 1 },
        metadata,
        state: {
            nextBlockId: 1,
            nextRunId: 1,
            blocks: [],
            messageRefs: { byRaw: {}, byRef: {} },
        },
        blockContents: new Map(),
        lastMessages: [{ id: `${id}-m1`, role: "user", text: `hello ${id}`, contentType: "text" }],
        lastMessagesFolded: false,
        pluginSnapshot: undefined,
        contentStore: undefined,
    };
}

test("collision: same conversation id under two agents keeps two rows", () => {
    const dir = tmpdir("bili-key-collision-");
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        try {
            store.ingestSession(planIngest(mkRecord("shared-conv", { pluginAgent: "dsh" }, 2_000)));
            store.ingestSession(planIngest(mkRecord("shared-conv", { pluginAgent: "pi" }, 3_000)));

            const ids = store.listSessionIds();
            assert.ok(ids.includes(makeSessionKey("dsh", "shared-conv")), "dsh row missing");
            assert.ok(ids.includes(makeSessionKey("pi", "shared-conv")), "pi row missing");
            assert.equal(ids.filter((k) => parseSessionKey(k).convId === "shared-conv").length, 2);

            // Hintless lookup resolves deterministically to the newest-updated
            // row; the returned sessionId stays the bare conversation id.
            const bare = store.getSessionRow("shared-conv");
            assert.ok(bare, "bare lookup must find a collision winner");
            assert.equal(bare!.agent, "pi");
            assert.equal(bare!.sessionId, "shared-conv");

            // Exact keys never mix.
            assert.equal(store.getSessionRow(makeSessionKey("dsh", "shared-conv"))!.agent, "dsh");
            assert.equal(store.getSessionRow(makeSessionKey("pi", "shared-conv"))!.agent, "pi");
        } finally {
            store.close();
        }
    } finally {
        rmrf(dir);
    }
});

test("birth freeze: re-ingest updates mutable columns only; new agent mints a sibling", () => {
    const dir = tmpdir("bili-key-freeze-");
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        try {
            store.ingestSession(planIngest(mkRecord("freeze-conv", { pluginAgent: "dsh" }, 2_000)));
            // Same (agent, id), later save, drifted protocol: one row mutates.
            store.ingestSession(planIngest(mkRecord("freeze-conv", { pluginAgent: "dsh" }, 2_500, "anthropic")));

            const dsh = store.getSessionRow(makeSessionKey("dsh", "freeze-conv"));
            assert.ok(dsh, "dsh row must survive its own re-ingest");
            assert.equal(dsh!.agent, "dsh");
            assert.equal(dsh!.protocol, "anthropic", "mutable column must update");
            assert.equal(store.listSessionIds().filter((k) => parseSessionKey(k).convId === "freeze-conv").length, 1);

            // A different agent claiming the same id forks a sibling row.
            store.ingestSession(planIngest(mkRecord("freeze-conv", { pluginAgent: "kimi" }, 4_000)));
            const all = store.listSessionIds().filter((k) => parseSessionKey(k).convId === "freeze-conv");
            assert.deepEqual(all.sort(), [makeSessionKey("dsh", "freeze-conv"), makeSessionKey("kimi", "freeze-conv")].sort());
            assert.equal(store.getSessionRow(makeSessionKey("dsh", "freeze-conv"))!.protocol, "anthropic", "original row untouched");
            assert.equal(store.getSessionRow(makeSessionKey("kimi", "freeze-conv"))!.protocol, "openai");
        } finally {
            store.close();
        }
    } finally {
        rmrf(dir);
    }
});
