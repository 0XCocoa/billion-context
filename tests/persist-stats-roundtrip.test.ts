import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { createInitialState } from "acp-kernel";
import { SessionStore } from "../src/persist.ts";
import type { Session } from "../src/session.ts";
import { rmrf } from "./tmp-rm.ts";

function makeSession(id: string): Session {
    return {
        id,
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
    };
}

// #1336: the retrieval-quality ratio (wholeBlockRestores vs cheaper precise
// path available) is a LONG-RUN metric — if the loader forgets the counters,
// every restart silently resets the denominator/numerator and acp_status
// reports a bogus ratio. Persist → fresh store → same numbers.
test("stats retrieval-quality counters survive a reload round-trip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-pq-"));
    try {
        const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
        const s = makeSession("pq-1");
        s.stats.wholeBlockRestores = 3;
        s.stats.wholeBlockRestoresPreciseAvailable = 7;
        s.stats.rangeRestores = 2;
        await store.writeNow(s);
        await store.flushAll([]);

        const reloaded = new SessionStore({ dir, debounceMs: 5, enabled: true });
        const back = reloaded.loadSync("pq-1");
        assert.ok(back, "session reloaded");
        assert.equal(back.stats.wholeBlockRestores, 3, "wholeBlockRestores round-trips");
        assert.equal(back.stats.wholeBlockRestoresPreciseAvailable, 7, "wholeBlockRestoresPreciseAvailable round-trips");
        assert.equal(back.stats.rangeRestores, 2, "control counter still round-trips");
        await reloaded.flushAll([]);
    } finally {
        rmrf(dir);
    }
});

// #3266: the image_full fail-streak guardrail suppresses the restore note after
// repeated failures. The save path spreads session.stats wholesale, so if the
// loader's field-by-field whitelist forgets the field, every restart silently
// resets the streak and re-arms the note right back into the failure loop.
test("stats imageFullFailStreak survives a reload round-trip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-streak-"));
    try {
        const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
        const s = makeSession("streak-1");
        s.stats.imageFullFailStreak = 2;
        await store.writeNow(s);
        await store.flushAll([]);

        const sNone = makeSession("streak-none");
        await store.writeNow(sNone);
        await store.flushAll([]);

        const reloaded = new SessionStore({ dir, debounceMs: 5, enabled: true });
        const back = reloaded.loadSync("streak-1");
        assert.ok(back, "session reloaded");
        assert.equal(back.stats.imageFullFailStreak, 2, "imageFullFailStreak round-trips");
        // Absence must survive as absence: materializing 0 for sessions that never
        // used image_full would change their persisted bytes (storage corpus /
        // render-golden digests pin those bytes).
        const backNone = reloaded.loadSync("streak-none");
        assert.ok(backNone, "second session reloaded");
        assert.equal(backNone.stats.imageFullFailStreak, undefined, "absent streak stays absent");
        await reloaded.flushAll([]);
    } finally {
        rmrf(dir);
    }
});
