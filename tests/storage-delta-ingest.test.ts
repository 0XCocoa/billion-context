import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { markDirty, type Session } from "../src/session.ts";
import { InternCache, planIngest, toLegacyLike } from "../src/storage/ingest.ts";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import type { CoreMessage } from "acp-kernel";

/**
 * #3133: shadow-storage write-path cost must scale with NEW work, not with
 * the full log. Three regressions pin the three fixes:
 *  1. delta intern — a warm intern cache serializes only messages the plan
 *     has never seen; the emitted plan stays byte-identical.
 *  2. sampled verification — the read-back + double digest runs on the
 *     first ingest and then every VERIFY_EVERY_INGESTS-th; drift injected
 *     straight into the SQLite CAS is still caught on a sampled save.
 *  3. writerOff coalescing — a same-tick markDirty storm builds once per
 *     tick, not once per call.
 */

process.env.BILI_PERSIST_ZSTD = "0";
// Same hermeticity pin as the other storage suites: pin BOTH tiers so every
// leg controls its own mode explicitly (absent now defaults to shadow).
const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-delta-hermetic-"));
process.env.BILI_CONFIG_FILE = path.join(hermetic, "no-config.json");
process.env.BILI_STORAGE_UNIFIED = "legacy";

const CORPUS_ROOT = path.resolve(import.meta.dirname, "golden/storage-corpus");

function loadCorpusCase(name: string, id: string, protocol: string): Session {
    const seed = fs.mkdtempSync(path.join(os.tmpdir(), "bili-delta-seed-"));
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
}

function shadowStats(store: SessionStore): ShadowStatsView {
    const shadow = (store as unknown as { shadow?: { stats: ShadowStatsView } }).shadow;
    assert.ok(shadow, "sidecar must be open in shadow mode");
    return shadow.stats;
}

const flushMicrotasks = async (): Promise<void> => {
    await new Promise<void>((resolve) => setImmediate(resolve));
};

test("delta intern: warm cache serializes only NEW messages and the plan stays byte-identical", () => {
    const session = loadCorpusCase("folded", "corpus-folded", "anthropic");
    const legacy = toLegacyLike(session);

    // Cold pass: every message serialized once.
    const cache = new InternCache();
    const p1 = planIngest(legacy, cache);
    const cold = cache.serializations;
    assert.ok(cold > 0, "cold pass must serialize the full log");
    assert.equal(p1.messages.length, cold, "cold pass logs every serialized identity");

    // Warm pass over the SAME objects: zero new serializations.
    const p2 = planIngest(legacy, cache);
    assert.equal(cache.serializations, cold, "warm pass must not re-serialize any message");
    assert.deepEqual(p2, p1, "cached plan must be byte-identical to the uncached one");
    assert.deepEqual(planIngest(legacy), p1, "plan without a cache must stay identical too");

    // k appended messages cost exactly k serializations — not O(full log).
    const k = 3;
    const t1 = session.lastMessages;
    assert.ok(t1, "corpus tail must be present");
    for (let i = 0; i < k; i++) {
        const m: CoreMessage = { id: `delta-new-${i}`, role: "user", contentType: "text", text: `delta message ${i}` };
        t1.push(m);
    }
    const p3 = planIngest(legacy, cache);
    assert.equal(cache.serializations, cold + k, "appending k messages must serialize exactly k messages");
    assert.equal(p3.messages.length, cold + k, "k new identities join the log");
});

test("sampled verification: first ingest + every 20th read back; injected CAS drift is still caught", async () => {
    const prevMode = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = "shadow";
    const session = loadCorpusCase("folded", "corpus-folded", "anthropic");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-delta-shadow-"));
    try {
        const store = new SessionStore({ dir, debounceMs: 1, enabled: true });
        try {
            // 21 saves -> per-session ingests n=1..21 -> sampled at n=1 and n=21.
            for (let i = 0; i < 21; i++) await store.writeNow(session);
            const stats = shadowStats(store);
            assert.ok(stats.ingests >= 21, `expected at least 21 ingests, saw ${stats.ingests}`);
            assert.equal(stats.verifySamples, 2, "verify must run on ingest 1 and 21 only");
            assert.equal(stats.verifyOk, 2, "both sampled verifications must pass");
            assert.equal(stats.verifyDrift, 0);
        } finally {
            store.cancelAll();
            store.closeQuietly();
        }

        // Drift leg: tamper a CAS body AFTER a verified ingest. Re-ingests do
        // not repair it (putContent only bumps the refcount of a known hash),
        // so the next SAMPLED save (n=21) must report drift.
        const store2 = new SessionStore({ dir, debounceMs: 1, enabled: true });
        try {
            await store2.writeNow(session); // n=1: sampled, ok
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
            for (let i = 0; i < 20; i++) await store2.writeNow(session); // n=2..21
            const stats = shadowStats(store2);
            assert.equal(stats.verifySamples, 2);
            assert.equal(stats.verifyOk, 1, "only the pre-tamper sample may pass");
            assert.equal(stats.verifyDrift, 1, "the sampled save at n=21 must catch the CAS drift");
        } finally {
            store2.cancelAll();
            store2.closeQuietly();
        }
    } finally {
        process.env.BILI_STORAGE_UNIFIED = prevMode;
        rmBestEffort(dir);
    }
});

test("writerOff coalescing: a same-tick markDirty storm builds once per tick", async () => {
    const prevMode = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = "full";
    process.env.BILI_STORAGE_JSON_WRITER = "off";
    const session = loadCorpusCase("folded", "corpus-folded", "anthropic");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-delta-writeroff-"));
    const store = new SessionStore({ dir, debounceMs: 1, enabled: true });
    _setStoreForTest(store);
    try {
        const before = shadowStats(store).ingests;
        for (let i = 0; i < 5; i++) markDirty(session);
        // Armed, not yet built — the coalesced build runs at end of tick.
        assert.ok(store.hasPending(session.id), "armed writerOff build must count as pending");
        await flushMicrotasks();
        assert.equal(shadowStats(store).ingests - before, 1, "5 same-tick markDirty calls must build exactly once");
        assert.ok(!store.hasPending(session.id), "drained tick must leave nothing pending");

        // A second tick builds again — coalescing must not swallow future work.
        for (let i = 0; i < 5; i++) markDirty(session);
        await flushMicrotasks();
        assert.equal(shadowStats(store).ingests - before, 2, "a later tick must build again");
    } finally {
        store.cancelAll();
        store.closeQuietly();
        _setStoreForTest(new SessionStore({ enabled: false }));
        delete process.env.BILI_STORAGE_JSON_WRITER;
        process.env.BILI_STORAGE_UNIFIED = prevMode;
        rmBestEffort(dir);
    }
});

test("delta intern is wired end-to-end: repeated saves serialize only the appended tail", async () => {
    const prevMode = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = "shadow";
    const session = loadCorpusCase("folded", "corpus-folded", "anthropic");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-delta-e2e-"));
    try {
        const store = new SessionStore({ dir, debounceMs: 1, enabled: true });
        try {
            const shadow = (store as unknown as { shadow?: { internSerializations(id: string): number | null } }).shadow;
            assert.ok(shadow, "sidecar must be open in shadow mode");
            await store.writeNow(session);
            const cold = shadow.internSerializations(session.id);
            assert.ok(cold !== null && cold > 0, "first save must intern the full log");

            const k = 4;
            const t2 = session.lastMessages;
            assert.ok(t2, "corpus tail must be present");
            for (let i = 0; i < k; i++) {
                const m: CoreMessage = { id: `e2e-new-${i}`, role: "user", contentType: "text", text: `e2e delta ${i}` };
                t2.push(m);
            }
            await store.writeNow(session);
            assert.equal(shadow.internSerializations(session.id), cold! + k, "second save must serialize only the k appended messages");
        } finally {
            store.cancelAll();
            store.closeQuietly();
        }
    } finally {
        process.env.BILI_STORAGE_UNIFIED = prevMode;
        rmBestEffort(dir);
    }
});
