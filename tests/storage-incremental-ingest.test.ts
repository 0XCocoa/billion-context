import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { SessionStore } from "../src/persist.ts";
import { createSession, type Session } from "../src/session.ts";
import { planIngest, toLegacyLike } from "../src/storage/ingest.ts";
import { UnifiedStore } from "../src/storage/store.ts";
import { openSqliteDatabase, setPreferredSqliteEngineForTests, type SqliteEngineName } from "../src/storage/driver.ts";
import type { CoreMessage } from "acp-kernel";

/**
 * #3133 completion: the per-session seq ledger that makes steady-state shadow
 * saves cost O(new messages) instead of O(full log). Every wire entry point
 * hands the save path freshly parsed objects per request, so cross-save
 * identity must come from the ledger (ref-token / content-identity claims off
 * the SQLite rows), not from object references. These regressions pin:
 *  1. churned-ref steady state — a save whose whole tail arrived as new
 *     objects allocates ZERO ledger seqs (every message claimed); appended
 *     turns allocate exactly their count.
 *  2. pipeline equivalence — full (remap) and delta (ledger) ingests of the
 *     same sessions write byte-identical tables.
 *  3. PK-conflict heal — an externally written row stealing the next seq
 *     forces a re-seed + replay inside the save; the sidecar stays enabled.
 *  4. drift recovery — a sampled digest drift drops the ledger; the next
 *     save replays fully, the one after resumes delta.
 *  5. restart re-seed — a fresh process seeds the ledger from the DB and
 *     claims everything already stored.
 */

process.env.BILI_PERSIST_ZSTD = "0";
// Same hermeticity pin as the other storage suites: pin BOTH tiers so every
// leg controls its mode explicitly (absent now defaults to shadow).
const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-incr-hermetic-"));
process.env.BILI_CONFIG_FILE = path.join(hermetic, "no-config.json");
process.env.BILI_STORAGE_UNIFIED = "legacy";

const CORPUS_ROOT = path.resolve(import.meta.dirname, "golden/storage-corpus");

function loadCorpusCase(name: string, id: string, protocol: string): Session {
    const seed = fs.mkdtempSync(path.join(os.tmpdir(), "bili-incr-seed-"));
    try {
        fs.cpSync(path.join(CORPUS_ROOT, name), path.join(seed, name), { recursive: true });
        const loader = new SessionStore({ dir: path.join(seed, name), debounceMs: 1, enabled: true });
        const loaded = loader.loadSync(id, { protocol, upstreamOrigin: "http://127.0.0.1:8199" });
        loader.cancelAll();
        loader.closeQuietly();
        assert.ok(loaded, `${name}: corpus loadSync returned null`);
        assert.ok((loaded.lastMessages?.length ?? 0) > 0, `${name}: corpus case must carry a non-empty tail`);
        return loaded;
    } finally {
        fs.rmSync(seed, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
}

/** Windows: an ephemeral stray handle must not fail CI — best-effort delete
 *  with bounded retries, swallowed on persistent EBUSY/EPERM. */
function rmBestEffort(p: string): void {
    try {
        fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
        /* leaked temp dir on a Windows runner is harmless */
    }
}

interface ShadowStatsView {
    ingests: number;
    verifySamples: number;
    verifyOk: number;
    verifyDrift: number;
    deltaSaves: number;
    disabled: boolean;
}

function shadowOf(store: SessionStore): { stats: ShadowStatsView; store: UnifiedStore } {
    const shadow = (store as unknown as { shadow?: { stats: ShadowStatsView; store: UnifiedStore } }).shadow;
    assert.ok(shadow, "sidecar must be open in shadow mode");
    return shadow;
}

/** Ledger allocation cursor: advances exactly when a message had to be
 *  serialized and given a new seq — the measurable unit of save cost. */
function allocCursor(store: SessionStore, id: string): number {
    const ustore = shadowOf(store).store;
    const st = ustore.seqStateFor(id);
    assert.ok(st, "ledger must exist after a save");
    return st.nextSeq;
}

/** Simulate the production cycle: the next request re-parses the wire body
 *  into an all-new object graph — fresh identities for every message. */
function churn(session: Session): void {
    const t = session.lastMessages;
    assert.ok(t, "tail must be present");
    session.lastMessages = t.map((m) => ({ ...m }));
}

function pad6(n: number): string {
    return String(n).padStart(6, "0");
}

function synthSession(id: string, n: number): Session {
    const session = createSession(id, { protocol: "anthropic", upstreamOrigin: "http://127.0.0.1:8199" });
    const msgs: CoreMessage[] = [];
    const byRaw = session.state.messageRefs.byRaw;
    const byRef = session.state.messageRefs.byRef;
    for (let i = 0; i < n; i++) {
        const m: CoreMessage = { id: `syn-${pad6(i)}`, role: i % 2 ? "assistant" : "user", contentType: "text", text: `synthetic message ${i} ${"x".repeat(160)}` };
        // Keep both ref maps consistent — real sessions maintain them as a
        // pair (assignRefs), and the digest legs compare them independently.
        const token = `s${pad6(i)}`;
        byRaw[m.id] = token;
        byRef[token] = m.id;
        msgs.push(m);
    }
    session.lastMessages = msgs;
    return session;
}

function appendTurns(session: Session, k: number, base: number): void {
    const t = session.lastMessages;
    assert.ok(t, "tail must be present");
    const byRaw = session.state.messageRefs.byRaw;
    const byRef = session.state.messageRefs.byRef;
    for (let i = 0; i < k; i++) {
        const m: CoreMessage = { id: `syn-${pad6(base + i)}`, role: "user", contentType: "text", text: `appended turn ${base + i} ${"y".repeat(120)}` };
        const token = `s${pad6(base + i)}`;
        byRaw[m.id] = token;
        byRef[token] = m.id;
        t.push(m);
    }
}

test("incremental tier: churned refs allocate nothing; appends allocate exactly their count", async () => {
    const prevMode = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = "shadow";
    const N = 120;
    const session = synthSession("incr-t1", N);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-incr-t1-"));
    try {
        const store = new SessionStore({ dir, debounceMs: 1, enabled: true });
        try {
            await store.writeNow(session);
            const stats = shadowOf(store).stats;
            assert.equal(allocCursor(store, session.id), N, "cold save allocates the full log once");
            assert.equal(stats.deltaSaves, 1, "first save runs the delta path off an empty ledger");

            // Production cycle: the next save arrives with FRESH objects for
            // the entire tail — every message must be claimed, none allocated.
            churn(session);
            await store.writeNow(session);
            assert.equal(allocCursor(store, session.id), N, "a fully churned tail must claim every message via the ledger");

            appendTurns(session, 3, N);
            churn(session);
            await store.writeNow(session);
            assert.equal(allocCursor(store, session.id), N + 3, "appended turns allocate exactly their count");

            churn(session);
            await store.writeNow(session);
            assert.equal(allocCursor(store, session.id), N + 3, "the following save claims the appended turns too");

            // Drive to ingest n=21: the sampled verifications (n=1, n=21) must
            // pass on views rebuilt by the delta pipeline.
            let guard = 0;
            while (shadowOf(store).stats.ingests < 21 && guard++ < 60) {
                churn(session);
                await store.writeNow(session);
            }
            const s = shadowOf(store).stats;
            assert.equal(s.ingests, 21, "every writeNow must ingest exactly once");
            assert.equal(s.verifySamples, 2, "verify must run on ingest 1 and 21 only");
            assert.equal(s.verifyOk, 2, "both sampled verifications must pass");
            assert.equal(s.verifyDrift, 0);
            assert.equal(s.disabled, false);
        } finally {
            store.cancelAll();
            store.closeQuietly();
        }
    } finally {
        process.env.BILI_STORAGE_UNIFIED = prevMode;
        rmBestEffort(dir);
    }
});

test("pipeline equivalence: full (remap) and delta (ledger) ingests write identical tables", () => {
    const session = loadCorpusCase("folded", "corpus-folded", "anthropic");
    const dirX = fs.mkdtempSync(path.join(os.tmpdir(), "bili-incr-x-"));
    const dirY = fs.mkdtempSync(path.join(os.tmpdir(), "bili-incr-y-"));
    try {
        const x = UnifiedStore.open(path.join(dirX, "index.db"));
        const y = UnifiedStore.open(path.join(dirY, "index.db"));
        try {
            const round = (legacy: ReturnType<typeof toLegacyLike>): void => {
                x.ingestSession(planIngest(legacy));
                const stY = y.seqStateFor(session.id);
                assert.ok(stY, "ledger must seed for the delta leg");
                const py = planIngest(legacy, stY);
                assert.equal(py.delta, true, "delta leg must run in delta mode");
                y.ingestSession(py);
                y.commitDelta(session.id, py.newRegs ?? []);
            };
            round(toLegacyLike(session));
            appendTurns(session, 2, session.lastMessages?.length ?? 0);
            round(toLegacyLike(session));

            assert.deepEqual(y.getMessages(session.id), x.getMessages(session.id), "message tables must match byte for byte");
            assert.deepEqual(y.getBlocks(session.id), x.getBlocks(session.id), "block tables must match");
            assert.deepEqual(y.getRefs(session.id), x.getRefs(session.id), "ref ledgers must match");
            assert.deepEqual(y.getDeadRefs(session.id), x.getDeadRefs(session.id), "dead-ref ledgers must match");
            assert.deepEqual(y.getSessionRow(session.id), x.getSessionRow(session.id), "session rows (incl. tailJson) must match");
        } finally {
            x.close();
            y.close();
        }
    } finally {
        rmBestEffort(dirX);
        rmBestEffort(dirY);
    }
});

// The heal path must recognize constraint violations under BOTH engines —
// they report them differently (string code vs numeric errcode), and a missed
// classification turns a healable collision into a sidecar failure.
const requireMod = createRequire(import.meta.url);
function betterSqliteAvailable(): boolean {
    try {
        requireMod.resolve("better-sqlite3");
        return true;
    } catch {
        return false;
    }
}

function runHealCase(engine: SqliteEngineName): Promise<void> {
    return (async () => {
        const prevMode = process.env.BILI_STORAGE_UNIFIED;
        process.env.BILI_STORAGE_UNIFIED = "shadow";
        setPreferredSqliteEngineForTests(engine);
        const N = 40;
        const session = synthSession(`incr-t3-${engine}`, N);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-incr-t3-"));
        try {
        const store = new SessionStore({ dir, debounceMs: 1, enabled: true });
        try {
            await store.writeNow(session);
            assert.equal(allocCursor(store, session.id), N, "cold save allocates seqs 0..N-1");

            // An external writer inserts a row at the exact seq the ledger
            // would hand out next.
            const conn = openSqliteDatabase(path.join(dir, "index.db")).db;
            try {
                // The external writer references REAL content — reuse an
                // existing CAS hash so the content_hash FK holds.
                const hash = conn.prepare("SELECT content_hash FROM messages WHERE session_id = ? LIMIT 1").get(session.id) as { content_hash: string };
                assert.ok(hash.content_hash, "a content hash to reuse must exist");
                conn.prepare(
                    "INSERT INTO messages (session_id, seq, msg_id, ref, ref_num, role, kind, content_hash) VALUES (?, ?, 'ghost', NULL, NULL, 'user', 'message', ?)"
                ).run(session.id, N, hash.content_hash);
            } finally {
                conn.close();
            }

            // The next save allocates at the stolen seq → strict INSERT
            // conflicts → the save must heal internally and NOT throw.
            appendTurns(session, 1, N);
            churn(session);
            await store.writeNow(session);
            assert.equal(allocCursor(store, session.id), N + 2, "heal re-seeds past the foreign row and lands the new message at N+1");
            assert.equal(shadowOf(store).stats.disabled, false, "a healed conflict must not disable the sidecar");

            const conn2 = openSqliteDatabase(path.join(dir, "index.db")).db;
            let ghosts = 0;
            try {
                const rows = conn2.prepare("SELECT seq FROM messages WHERE session_id = ? AND msg_id = 'ghost'").all(session.id) as { seq: number }[];
                ghosts = rows.length;
                assert.deepEqual(rows.map((r) => r.seq), [N], "the foreign row survives untouched");
            } finally {
                conn2.close();
            }
            assert.equal(ghosts, 1);

            // Steady state resumes after the heal...
            churn(session);
            await store.writeNow(session);
            assert.equal(allocCursor(store, session.id), N + 2, "post-heal churned save claims everything again");
        } finally {
            store.cancelAll();
            store.closeQuietly();
        }
    } finally {
        setPreferredSqliteEngineForTests(null);
        process.env.BILI_STORAGE_UNIFIED = prevMode;
        rmBestEffort(dir);
    }
    })();
}

test("PK-conflict heal [node:sqlite]: a foreign row stealing the next seq forces reseed + replay", () => runHealCase("node:sqlite"));
test("PK-conflict heal [better-sqlite3]: same contract under the string-code engine", { skip: !betterSqliteAvailable() && "better-sqlite3 not installed (optional native dependency)" }, () => runHealCase("better-sqlite3"));

test("drift recovery: a sampled drift drops the ledger; next save replays fully, the one after resumes delta", async () => {
    const prevMode = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = "shadow";
    const session = loadCorpusCase("folded", "corpus-folded", "anthropic");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-incr-t4-"));
    try {
        const store = new SessionStore({ dir, debounceMs: 1, enabled: true });
        try {
            await store.writeNow(session); // n=1: sampled, ok
            const conn = openSqliteDatabase(path.join(dir, "index.db")).db;
            try {
                const row = conn
                    .prepare("SELECT content_hash FROM messages WHERE session_id = ? ORDER BY seq LIMIT 1")
                    .get(session.id) as { content_hash: string } | undefined;
                assert.ok(row, "messages row to tamper must exist");
                // Valid message JSON (a throw would be a failure, not drift).
                conn
                    .prepare("UPDATE content SET bytes = ? WHERE hash = ?")
                    .run(Buffer.from(JSON.stringify({ id: "tampered", role: "user", contentType: "text", text: "tampered" }), "utf8"), row.content_hash);
            } finally {
                conn.close();
            }
            for (let i = 0; i < 20; i++) await store.writeNow(session); // n=2..21
            let stats = shadowOf(store).stats;
            assert.equal(stats.verifySamples, 2);
            assert.equal(stats.verifyDrift, 1, "the sampled save at n=21 must catch the CAS drift");
            const deltaBeforeReplay = stats.deltaSaves;

            // n=22: the drift dropped the ledger and armed a forced-full save.
            churn(session);
            await store.writeNow(session);
            stats = shadowOf(store).stats;
            assert.equal(stats.deltaSaves, deltaBeforeReplay, "the post-drift save must replay fully (no delta save)");
            assert.equal(stats.disabled, false);

            // n=23: the ledger re-seeds from the DB and delta mode resumes.
            churn(session);
            await store.writeNow(session);
            const cursorAfterResume = allocCursor(store, session.id);
            stats = shadowOf(store).stats;
            assert.equal(stats.deltaSaves, deltaBeforeReplay + 1, "the save after the forced replay must resume delta mode");
            const cursorAfterSteady = allocCursor(store, session.id);
            assert.equal(cursorAfterSteady, cursorAfterResume, "and it must claim everything again");
        } finally {
            store.cancelAll();
            store.closeQuietly();
        }
    } finally {
        process.env.BILI_STORAGE_UNIFIED = prevMode;
        rmBestEffort(dir);
    }
});

test("restart re-seed: a fresh store seeds the ledger from the DB and claims everything stored", async () => {
    const prevMode = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = "shadow";
    const N = 80;
    const session = synthSession("incr-t5", N);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-incr-t5-"));
    try {
        const store1 = new SessionStore({ dir, debounceMs: 1, enabled: true });
        try {
            await store1.writeNow(session);
            assert.equal(allocCursor(store1, session.id), N);
        } finally {
            store1.cancelAll();
            store1.closeQuietly();
        }

        appendTurns(session, 2, N);
        churn(session);
        const store2 = new SessionStore({ dir, debounceMs: 1, enabled: true });
        try {
            await store2.writeNow(session);
            assert.equal(allocCursor(store2, session.id), N + 2, "restarted ledger must claim the N stored messages and allocate only the 2 new ones");
            assert.equal(shadowOf(store2).stats.verifyOk, 1, "the restarted first save's sampled verify must pass");
        } finally {
            store2.cancelAll();
            store2.closeQuietly();
        }
    } finally {
        process.env.BILI_STORAGE_UNIFIED = prevMode;
        rmBestEffort(dir);
    }
});
