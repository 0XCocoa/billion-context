/**
 * #5188 (open-side half of the #5140 fix): a sidecar whose FIRST synchronous
 * open died on a transient OS error used to degrade the whole process to
 * legacy-only for its lifetime — no retry path existed anywhere. Under CI-shard
 * machine load (many test processes sharing one disk) that one unlucky open at
 * construction time is exactly what stripped the unified layer, and the fork
 * raw-tail rebuild (#5140's HTTP 409 SNAPSHOT_UNAVAILABLE) fails closed on
 * replicasAvailable().
 *
 * Recovery is demand-driven on BOTH consumer classes, each with its own pace:
 * - save path (scheduleSave/flushSync): one maybeOpen per 30 s cooldown window;
 * - read path (replicasAvailable): one maybeOpen per 100 ms interval — a read
 *   asking "are replicas available?" gets a fresh answer instead of waiting for
 *   the next write. #5140's flake was precisely that gap: ctor open dies under
 *   shard load, the resource clears milliseconds later, and the cold-restore
 *   snapshot request arrives before any save could trigger a retry — and the
 *   old constructor-time cooldown stamp gated even the first retry for 30 s.
 *
 * Both directions pinned (#3617): recovery works without a restart once the
 * resource returns (no save required on the read timeline), AND while
 * gated/failed the store keeps serving (JSON durability intact, bounded
 * attempt counts per pace, no retry spam inside either window).
 *
 * The strike-side half of #5188 (transient vs structural ingest-error
 * classification) has its own suite: tests/issue5140-contention-not-disabling.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore, setShadowReopenCooldownMsForTests, setShadowReopenReadCheckMsForTests } from "../src/persist.ts";
import { setSqliteEnginesUnavailableForTests } from "../src/storage/driver.ts";
import { _resetStorageRuntimeStatusForTest, storageStatusWire } from "../src/storage/runtime-status.ts";
import { setLogCapture } from "../src/logger.ts";
import { createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";

const HERMETIC = fs.mkdtempSync(path.join(os.tmpdir(), "bili-5188-hermetic-"));
process.env.BILI_CONFIG_FILE = path.join(HERMETIC, "no-config.json");
delete process.env.BILI_STORAGE_UNIFIED;
delete process.env.BILI_ENCRYPTION_KEY;

function mkSess(id = "rec-s1"): Session {
    return { id, meta: { protocol: "anthropic" }, metadata: {}, stats: { requests: 1 }, state: createInitialState() } as unknown as Session;
}

test("sidecar recovers without a restart once the resource returns (#5188)", () => {
    const dir = fs.mkdtempSync(path.join(HERMETIC, "rec-"));
    let store: SessionStore | undefined;
    try {
        _resetStorageRuntimeStatusForTest();
        setShadowReopenCooldownMsForTests(0);
        setSqliteEnginesUnavailableForTests(true);
        store = new SessionStore({ dir, enabled: true });
        assert.equal(store.replicasAvailable(), false, "unlucky first open degrades to legacy-only");
        assert.equal(storageStatusWire().degraded, true, "degraded state observable on the status wire");
        // resource returns mid-process; the very next save retries immediately
        // (the constructor's failed open does not consume the retry budget)
        setSqliteEnginesUnavailableForTests(false);
        store.scheduleSave(mkSess());
        assert.equal(store.replicasAvailable(), true, "recovered by the save path without a restart");
        assert.equal(storageStatusWire().degraded, false, "status wire clears with the recovery");
    } finally {
        setShadowReopenCooldownMsForTests(null);
        setSqliteEnginesUnavailableForTests(false);
        _resetStorageRuntimeStatusForTest();
        store?.closeQuietly();
    }
});

test("each pace gates its own retries and JSON durability holds while degraded (#5188)", async () => {
    const dir = fs.mkdtempSync(path.join(HERMETIC, "gate-"));
    let store: SessionStore | undefined;
    const warns: string[] = [];
    try {
        _resetStorageRuntimeStatusForTest();
        setLogCapture((level, msg) => { if (level === "warn") warns.push(msg); });
        setSqliteEnginesUnavailableForTests(true);
        setShadowReopenCooldownMsForTests(300);
        setShadowReopenReadCheckMsForTests(300);
        store = new SessionStore({ dir, enabled: true });
        const failedOpens = () => warns.filter((w) => /failed to open/.test(w)).length;
        assert.equal(failedOpens(), 1, "exactly one failed-open warn from construction");
        // the ctor failure does NOT consume either pace: the first save fires
        // one immediate attempt…
        store.scheduleSave(mkSess("g1"));
        assert.equal(failedOpens(), 2, "first save retries immediately (no constructor-time stamp)");
        // …and its failure arms the save cooldown: further saves stay quiet…
        store.flushSync(mkSess("g2"));
        assert.equal(failedOpens(), 2, "the second save is gated by the cooldown the first attempt armed");
        // …while the read path takes its own single immediate attempt…
        assert.equal(store.replicasAvailable(), false, "still legacy-only while the resource is gone");
        assert.equal(failedOpens(), 3, "the first read check fires its own immediate attempt");
        // …and everything inside both windows stays quiet…
        store.scheduleSave(mkSess("g3"));
        store.flushSync(mkSess("g4"));
        store.replicasAvailable();
        assert.equal(failedOpens(), 3, "no retry spam inside either window");
        // …until the windows elapse, then the next attempt recovers.
        setSqliteEnginesUnavailableForTests(false);
        await new Promise((r) => setTimeout(r, 400));
        store.scheduleSave(mkSess("g5"));
        assert.equal(store.replicasAvailable(), true, "post-cooldown attempt succeeds once the resource returns");
    } finally {
        setLogCapture(null);
        setShadowReopenCooldownMsForTests(null);
        setShadowReopenReadCheckMsForTests(null);
        setSqliteEnginesUnavailableForTests(false);
        _resetStorageRuntimeStatusForTest();
        store?.closeQuietly();
    }
});

test("an unlucky first open recovers on the next read check — no save, no 30 s wait (#5140 timeline)", async () => {
    const dir = fs.mkdtempSync(path.join(HERMETIC, "tl-"));
    let store: SessionStore | undefined;
    try {
        _resetStorageRuntimeStatusForTest();
        // NO seams: production pacing applies. This is #5140's exact CI
        // timeline — the ctor open dies under shard load, the resource clears
        // milliseconds later, and the cold-restore snapshot request (a pure
        // READ) arrives before any save could trigger a retry. Before the fix
        // this returned false forever: the constructor stamped a 30 s cooldown
        // and only the save path ever retried.
        setSqliteEnginesUnavailableForTests(true);
        store = new SessionStore({ dir, enabled: true });
        assert.equal(store.replicasAvailable(), false, "unlucky first open degrades to legacy-only");
        setSqliteEnginesUnavailableForTests(false);
        // production read-check interval is 100 ms; wait past one slot so the
        // next availability check is definitely eligible
        await new Promise((r) => setTimeout(r, 150));
        assert.equal(store.replicasAvailable(), true, "a plain read recovers the sidecar — no save anywhere in this timeline");
        assert.equal(storageStatusWire().degraded, false, "status wire clears with the recovery");
    } finally {
        setSqliteEnginesUnavailableForTests(false);
        _resetStorageRuntimeStatusForTest();
        store?.closeQuietly();
    }
});
