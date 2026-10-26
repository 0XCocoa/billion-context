import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

import { settleUsageReport } from "../src/cache-ledger.ts";
import { effectiveTokenCount } from "../src/server.ts";
import type { Session } from "../src/session.ts";
import type { CoreMessage } from "acp-kernel";

// #4805 / #4720 family: a tiny side-lane request (2 messages, its own short
// system prompt) riding the SAME session id settles a 5100-token usage sample
// over the main conversation's 300K-token anchor. The anchor write froze the
// nudge (growth 3900 < floor 22500) while the real context kept growing to
// 1.2M — compression permanently stopped, and once requests started failing
// (no usage on failure) nothing could repair the anchor. Two guards, each
// independently breaking the loop:
//  - settleUsageReport: a usage sample >=8x smaller than the current
//    usage-grade anchor (with no compress credit) is side-lane pollution —
//    counters only, anchor kept;
//  - effectiveTokenCount: a fresh anchor whose size is impossible for the
//    payload at hand (upper bound >=8x the anchor, >25K absolute gap) cannot
//    size THIS request — fall through to the local estimate.

function sessionWith(anchor: number): Session {
    return {
        id: "s4805",
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: anchor, lastInputTokensSource: "usage", contextTokens: anchor } as never,
        metadata: {},
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
    } as never as Session;
}

function bigHistory(count: number): CoreMessage[] {
    const msgs: CoreMessage[] = [];
    for (let i = 0; i < count; i++) {
        msgs.push({ id: `m${i}`, role: i % 2 === 0 ? "user" : "assistant", contentType: "text", text: "x".repeat(6000) });
    }
    return msgs;
}

test("T1 settle gate: a usage sample 8x smaller than the anchor is side-lane pollution — anchor kept, counters still accrue", () => {
    const session = sessionWith(300_000);
    settleUsageReport(session, { total: 5_100, reportedCached: 128, output: 30, protocol: "openai" });
    assert.equal(session.stats.lastInputTokens, 300_000, "the 5100-tok side sample must NOT overwrite a 300K anchor (#4805)");
    assert.equal(session.stats.lastInputTokensSource, "usage");
    assert.equal(session.stats.inputTokens, 5_100, "the sample still counts toward cumulative usage");
    // A same-lane report (300K -> 290K, ratio fine) writes normally.
    settleUsageReport(session, { total: 290_000, reportedCached: null, protocol: "openai" });
    assert.equal(session.stats.lastInputTokens, 290_000, "main-lane reports keep updating the anchor");
});

test("T1b settle gate exemptions: no anchor yet, non-usage anchor, and post-fold credit settles all pass", () => {
    const fresh = sessionWith(0);
    settleUsageReport(fresh, { total: 5_100, reportedCached: null });
    assert.equal(fresh.stats.lastInputTokens, 5_100, "first settle on an empty anchor always writes");

    const estimate = sessionWith(300_000);
    (estimate.stats as { lastInputTokensSource?: string }).lastInputTokensSource = "estimate";
    settleUsageReport(estimate, { total: 5_100, reportedCached: null });
    assert.equal(estimate.stats.lastInputTokens, 5_100, "an estimate-grade anchor is always replaceable by usage");

    const folded = sessionWith(300_000);
    (folded.stats as { compressCreditTokens?: number }).compressCreditTokens = 40_000;
    settleUsageReport(folded, { total: 30_000, reportedCached: null });
    assert.equal(folded.stats.lastInputTokens, 0, "a credit-carrying (post-fold) settle nets against the credit and writes — our own shrinkage is not side-lane");
});

test("T2 meter guard: even with a polluted 5100 anchor, a 1.2M-token payload is sized by its own estimate", () => {
    const session = sessionWith(5_100);
    const msgs = bigHistory(800); // ~4.8M chars -> ~1.2M tokens upper bound >> 5100*8
    const verdict = effectiveTokenCount(session, msgs, 0);
    assert.notEqual(verdict.tokens, 5_100, `the impossible anchor must not size a ${verdict.tokens}-token payload request`);
    assert.equal(verdict.source, "estimate", "falls through to the local measurement (#4805 size guard)");
    // Small-session growth stays on the anchor: no absolute-gap trip below 25K.
    const small = sessionWith(800);
    const earlyMsgs = bigHistory(3);
    const early = effectiveTokenCount(small, earlyMsgs, 0);
    assert.equal(early.tokens, 800, "early-session anchors keep sizing small payloads (no false trips)");
});
