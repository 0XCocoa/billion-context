import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { SessionStore, _setStoreForTest, relPathFor } from "../src/persist.ts";
import { createSession, getSession, acquireInFlight, releaseInFlight, markDirty, listSessions, _resetSessionsForTest } from "../src/session.ts";

async function fixture(run: (dir: string, store: SessionStore) => Promise<void>): Promise<void> {
    const root = mkdtempSync(path.join(tmpdir(), "bili-bounded-"));
    const dir = path.join(root, "sessions");
    const store = new SessionStore({ dir, enabled: true, debounceMs: 0 });
    _resetSessionsForTest(256, 512 * 1024 * 1024);
    _setStoreForTest(store);
    try { await run(dir, store); }
    finally {
        store.closeQuietly();
        _resetSessionsForTest(256, 512 * 1024 * 1024);
        _setStoreForTest(new SessionStore({ enabled: false }));
        rmSync(root, { recursive: true, force: true });
    }
}

test("bounded boot retains a small warm cache and reloads older exact originals", async () => fixture(async (_dir, store) => {
    for (let i = 0; i < 30; i++) {
        const session = createSession(`bounded-${i}`, { label: `bounded-${i}` });
        session.blockContents.set("b1", { one: null, full: { text: `original-${i}-` + "x".repeat(10000), count: 1 } });
        await store.writeNow(session);
    }
    const loaded = await store.boot({ maxSessions: 3, maxBytes: 40000 });
    assert.ok(loaded.size <= 3);
    assert.equal(store.loadSync("bounded-0")?.blockContents.get("b1")?.full?.text, "original-0-" + "x".repeat(10000));
}));

test("first migration adopts legacy labels lazily while preserving historical bytes", async () => fixture(async (dir, store) => {
    const session = createSession("old-derived-id", { label: "ses_native_id" });
    session.state.messageRefs.byRaw["old-message"] = "m00001";
    session.state.messageRefs.byRef["m00001"] = "old-message";
    session.blockContents.set("b1", { one: null, full: { text: "legacy original\r\n", count: 1 } });
    await store.writeNow(session);
    const file = path.join(dir, relPathFor(session.id));
    const before = readFileSync(file);
    await store.boot({ maxSessions: 1, maxBytes: 40000 });
    const adopted = store.loadSync("ses_native_id");
    assert.equal(adopted?.id, "ses_native_id");
    assert.deepEqual(adopted?.state.messageRefs, session.state.messageRefs);
    assert.deepEqual(adopted?.blockContents.get("b1"), session.blockContents.get("b1"));
    assert.deepEqual(readFileSync(file), before);
}));

test("cold state resumes transparently; corrupt matching state cannot become empty history", async () => fixture(async (dir, store) => {
    const session = createSession("ses_cold", { label: "ses_cold" });
    session.stats.requests = 42;
    await store.writeNow(session);
    const rel = relPathFor(session.id);
    const cold = `${dir}-cold`;
    mkdirSync(path.dirname(path.join(cold, rel)), { recursive: true });
    renameSync(path.join(dir, rel), path.join(cold, rel));
    await store.boot({ maxSessions: 1, maxBytes: 40000 });
    assert.equal(store.loadSync(session.id)?.stats.requests, 42);
    writeFileSync(path.join(cold, rel), "{broken");
    assert.throws(() => store.loadSync(session.id));
    assert.equal(readFileSync(path.join(cold, rel), "utf8"), "{broken");
}));

test("failed CCR save blocks state flush and retains dirty originals", async () => fixture(async (dir, store) => {
    const session = createSession("failed-originals", { label: "failed-originals" });
    session.stats.requests = 1;
    await store.writeNow(session);
    const rel = relPathFor(session.id);
    const before = readFileSync(path.join(dir, rel));
    mkdirSync(path.join(dir, rel.replace(/\.json$/, ".content-store.json")));
    session.stats.requests = 2;
    session.contentStoreDirty = true;
    assert.equal(store.flushSync(session), false);
    assert.equal(session.contentStoreDirty, true);
    assert.deepEqual(readFileSync(path.join(dir, rel)), before);
}));

test("bounded server reads refuse corrupt originals without replacing them", async () => fixture(async (dir, store) => {
    const session = createSession("corrupt-originals", { label: "corrupt-originals" });
    await store.writeNow(session);
    await store.boot({ maxSessions: 0, maxBytes: 0 });
    const file = path.join(dir, relPathFor(session.id).replace(/\.json$/, ".content-store.json"));
    const broken = "{truncated historical original";
    writeFileSync(file, broken);
    assert.throws(() => store.loadContentStore(session), /refusing to replace its originals/);
    assert.equal(readFileSync(file, "utf8"), broken);
}));

test("corrupt newly written live state overrides cold history and fails closed", async () => fixture(async (dir, store) => {
    const session = createSession("ses_live_corrupt", { label: "ses_live_corrupt" });
    await store.writeNow(session);
    const rel = relPathFor(session.id);
    const cold = `${dir}-cold`;
    mkdirSync(path.dirname(path.join(cold, rel)), { recursive: true });
    renameSync(path.join(dir, rel), path.join(cold, rel));
    await store.boot({ maxSessions: 0, maxBytes: 0 });
    writeFileSync(path.join(dir, rel), "{broken new live state");
    assert.throws(() => store.loadSync(session.id), /refusing an empty resume/);
    assert.equal(readFileSync(path.join(dir, rel), "utf8"), "{broken new live state");
}));

test("already-persisted sessions are retained when saving newer mutations fails", async () => fixture(async (_dir, store) => {
    _resetSessionsForTest(1);
    const session = getSession("saved-before");
    session.persisted = true;
    session.metadata.newer = "unsaved work";
    store.flushSync = () => false;
    assert.throws(() => getSession("another-session"), /pool exhausted/);
    assert.equal(getSession("saved-before"), session);
    assert.equal(session.metadata.newer, "unsaved work");
}));

test("byte budget pins active state, admits concurrent requests, and releases idle state to disk", async () => fixture(async (_dir, store) => {
    _resetSessionsForTest(256, 32000);
    const session = getSession("large-active");
    acquireInFlight(session);
    session.metadata.original = "x".repeat(20000);
    markDirty(session);
    const concurrent = getSession("concurrent-request");
    acquireInFlight(concurrent);
    assert.equal(getSession("large-active"), session);
    assert.equal(getSession("concurrent-request"), concurrent);
    assert.ok(listSessions().includes(session));
    releaseInFlight(session);
    assert.ok(!listSessions().includes(session));
    assert.equal(store.loadSync(session.id)?.metadata.original, "x".repeat(20000));
    releaseInFlight(concurrent);
}));

test("bounded boot preserves unified-first reads when the JSON copy is older", async () => {
    const previous = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = "full";
    try {
        await fixture(async (dir, store) => {
            const session = createSession("ses_unified_bounded", { label: "ses_unified_bounded" });
            session.stats.requests = 9;
            session.metadata.original = "unified original\r\n";
            await store.writeNow(session);
            const file = path.join(dir, relPathFor(session.id));
            const envelope = JSON.parse(readFileSync(file, "utf8"));
            envelope.payload.stats.requests = 1;
            envelope.payload.savedAt = 1;
            writeFileSync(file, JSON.stringify(envelope));
            const warm = await store.boot({ maxSessions: 1, maxBytes: 40000 });
            assert.equal(warm.get(session.id)?.stats.requests, 9, "bounded warmup must retain the newer index record");
            await store.boot({ maxSessions: 0, maxBytes: 0 });
            const resumed = store.loadSync(session.id);
            assert.equal(resumed?.stats.requests, 9, "lazy reload still prefers the unified index");
            assert.equal(resumed?.metadata.original, "unified original\r\n");
        });
    } finally {
        if (previous === undefined) delete process.env.BILI_STORAGE_UNIFIED;
        else process.env.BILI_STORAGE_UNIFIED = previous;
    }
});
