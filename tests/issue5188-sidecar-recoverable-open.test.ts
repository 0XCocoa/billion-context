/**
 * #5188 (open-side half of the #5140 fix): a sidecar whose FIRST synchronous
 * open died on a transient OS error used to degrade the whole process to
 * legacy-only for its lifetime — no retry path existed anywhere. Under CI-shard
 * machine load (many test processes sharing one disk) that one unlucky open at
 * construction time is exactly what stripped the unified layer, and the fork
 * raw-tail rebuild (#5140's HTTP 409 SNAPSHOT_UNAVAILABLE) fails closed on
 * replicasAvailable(). The save path is now the "this store is still wanted"
 * signal: one maybeOpen per 30 s cooldown window, boolean-gated per save, until
 * the resource returns — then unified surfaces resume WITHOUT a restart.
 *
 * Both directions pinned (#3617): recovery works without a restart once the
 * resource returns, AND while gated/failed the store keeps serving (JSON
 * durability intact, exactly one failed-open warn from construction, no retry
 * spam inside the cooldown).
 *
 * The strike-side half of #5188 (transient vs structural ingest-error
 * classification) has its own suite: tests/issue5140-contention-not-disabling.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore, setShadowReopenCooldownMsForTests } from "../src/persist.ts";
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
        // Cooldown seam BEFORE construction: the ctor stamps the first retry
        // gate with the cooldown active at that moment (now + cooldown).
        setShadowReopenCooldownMsForTests(0);
        setSqliteEnginesUnavailableForTests(true);
        store = new SessionStore({ dir, enabled: true });
        assert.equal(store.replicasAvailable(), false, "unlucky first open degrades to legacy-only");
        assert.equal(storageStatusWire().degraded, true, "degraded state observable on the status wire");
        // resource returns mid-process; the 0 ms cooldown armed at ctor lets
        // the very next save retry immediately
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

test("cooldown gates retries and JSON durability holds while degraded (#5188)", async () => {
    const dir = fs.mkdtempSync(path.join(HERMETIC, "gate-"));
    let store: SessionStore | undefined;
    const warns: string[] = [];
    try {
        _resetStorageRuntimeStatusForTest();
        setLogCapture((level, msg) => { if (level === "warn") warns.push(msg); });
        setSqliteEnginesUnavailableForTests(true);
        // Small cooldown FROM CONSTRUCTION so the ctor's next-attempt stamp
        // (now + cooldown) sits inside the test window…
        setShadowReopenCooldownMsForTests(300);
        store = new SessionStore({ dir, enabled: true });
        const ctorWarns = warns.filter((w) => /failed to open/.test(w));
        assert.equal(ctorWarns.length, 1, "exactly one failed-open warn from construction");
        // activity well inside the cooldown window must NOT fire retries…
        store.scheduleSave(mkSess("g1"));
        store.scheduleSave(mkSess("g2"));
        // (flushSync on a bare fixture can report its kernel-store commit as
        // partial — envelope durability itself is pinned by the #4175/
        // persistence suites; here the call exists to exercise the recovery
        // hook on the eviction path.)
        store.flushSync(mkSess("g3"));
        assert.equal(warns.filter((w) => /failed to open/.test(w)).length, 1, "no retry spam inside the cooldown");
        assert.equal(store.replicasAvailable(), false, "still legacy-only while the resource is gone");
        // …and the next attempt happens AFTER the cooldown, then recovers.
        setSqliteEnginesUnavailableForTests(false);
        await new Promise((r) => setTimeout(r, 400));
        store.scheduleSave(mkSess("g4"));
        assert.equal(store.replicasAvailable(), true, "post-cooldown attempt succeeds once the resource returns");
    } finally {
        setLogCapture(null);
        setShadowReopenCooldownMsForTests(null);
        setSqliteEnginesUnavailableForTests(false);
        _resetStorageRuntimeStatusForTest();
        store?.closeQuietly();
    }
});
