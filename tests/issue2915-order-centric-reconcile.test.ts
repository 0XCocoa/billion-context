// [#2915] Order-centric reconciliation — owner rule 2026-10-12:
// 顺序为中心,hash 为辅助 (order is the carrier, content the per-cell gate,
// the id a fast path — never a death sentence).
//
// Replays the #2821 incident (beicause, dsh 0.2.0-rc.2 + bili 0.1.193): a
// mid-session model switch re-minted EVERY tool-call id on re-projection
// (content byte-identical, ids different). The old Pass 0 stopped at the
// first fingerprint mismatch and both flank scans died at their first cells
// (changed preamble at the head, appended turn at the tail): byPos=0,
// 3289 covered ids missing, three passes → "compression substrate appears
// destroyed" → ALL folds dropped → ~4MB raw out → doomed-probe 502.
//
// The order-centric upgrade (#2915):
//   - Pass 0 RESYNCS at the next run of consecutive same-index agreements:
//     an order break is a gap, not a wall — verified spans past the break
//     keep their coverage, gap cells fall through honestly.
//   - Pass 1.5 claims tool-id twins (#2396 detection promoted): exact
//     normalized content equality under a rewritten toolCallId, k-th
//     discipline, length-guarded — the fallback when no stored copy exists.
//   - Escalation to "substrate destroyed" only counts gaps that survived
//     resync AND the twin/norm content passes.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
    normalizedIdentity,
    normalizedIdentityNoToolCallId,
    positionalFingerprint,
    planReconciliation,
    reconcileFoldCoverage,
    type FoldAnchor,
    type ReconcileOptions,
} from "../src/fold-reconcile.ts";
import type { CoreMessage } from "acp-kernel";
import type { Session } from "../src/session.ts";

function msg(id: string, role: string, text: string, extra?: Partial<CoreMessage>): CoreMessage {
    return { id, role, contentType: "text", text, ...extra } as CoreMessage;
}
/** Real-identity anchors (n + t + m) — the shape reconcileFoldCoverage seeds. */
function anchorOf(m: CoreMessage): FoldAnchor {
    const a: FoldAnchor = { n: normalizedIdentity(m), r: m.role, c: m.contentType, b: m.text?.length ?? 0 };
    if (m.toolCallId) {
        a.t = m.toolCallId;
        a.m = normalizedIdentityNoToolCallId(m);
    }
    return a;
}
function fakeSession(ids: string[]): Session {
    return {
        state: { blocks: [{ active: true, blockId: "blk-2915", effectiveMessageIds: [...ids] }] },
        metadata: {},
    } as unknown as Session;
}
const opts = (log?: (level: string, m: string) => void): ReconcileOptions => ({ mode: "repair", sessionId: "s2915", log: log ?? (() => {}) });

/** A #2821-shaped history: preamble + prose turns + tool calls with composite
 *  ids (`call_x|fc_N`) — exactly the field dsh re-projection rewrites. */
function history(): CoreMessage[] {
    return [
        msg("pre", "user", "session preamble: project setup instructions"),
        msg("m1", "user", "first user turn body"),
        msg("t1", "assistant", '{"query":"step one","limit":1}', { contentType: "tool-call", toolName: "search", toolCallId: "call_x|fc_1" }),
        msg("m2", "assistant", "assistant reply after step one"),
        msg("t2", "assistant", '{"query":"step two","limit":2}', { contentType: "tool-call", toolName: "search", toolCallId: "call_x|fc_2" }),
        msg("m3", "user", "third user turn body"),
        msg("t3", "assistant", '{"query":"step three","limit":3}', { contentType: "tool-call", toolName: "search", toolCallId: "call_x|fc_3" }),
        msg("m4", "assistant", "fourth message body"),
        msg("m5", "user", "fifth message body"),
        msg("m6", "assistant", "sixth message body"),
        msg("m7", "user", "seventh message body"),
        msg("end", "assistant", "final turn body"),
    ];
}

/** dsh-style re-projection: EVERY id re-minted, every composite toolCallId
 *  rewritten (`|` → `_`), content byte-identical. `changePreamble` also
 *  replaces the first message's text (a model switch rewrites its wrapper). */
function remint(old: CoreMessage[], gen: string, changePreamble = false, append?: string): CoreMessage[] {
    const out = old.map((m, i) => {
        const text = i === 0 && changePreamble ? `${m.text} [rewritten by model switch]` : m.text;
        return msg(`${gen}_${i}`, m.role, text ?? "", {
            contentType: m.contentType,
            toolName: m.toolName,
            toolCallId: m.toolCallId !== undefined ? m.toolCallId.replace("|", "_") : undefined,
        });
    });
    if (append !== undefined) out.push(msg(`${gen}_app`, "user", append));
    return out;
}

function planFor(old: CoreMessage[], next: CoreMessage[], positions?: { ids: string[]; canon: string[] }) {
    const order = old.map((m) => m.id as string);
    const anchors: Record<string, FoldAnchor> = {};
    for (const m of old) anchors[m.id as string] = anchorOf(m);
    const covered = new Set(order);
    return planReconciliation(order, anchors, next, covered, positions);
}
const storedOf = (msgs: CoreMessage[]): { ids: string[]; canon: string[] } =>
    ({ ids: msgs.map((m) => m.id as string), canon: msgs.map((m) => positionalFingerprint(m)) });

describe("Pass 0 order-centric resync (#2915)", () => {
    test("#2821 replay: full id re-mint + changed preamble + appended turn — order carries, one resync, no mass loss", () => {
        const old = history();
        const next = remint(old, "g1", true, "brand new request turn");
        const plan = planFor(old, next, storedOf(old));
        // the head scan crosses the changed-preamble island and claims every
        // verified cell behind it; the tail scan crosses the appended turn
        assert.ok(plan.resyncs >= 1, `expected resyncs, got ${plan.resyncs}`);
        assert.equal(plan.byPos, 11, "all non-preamble ids claimed positionally");
        assert.deepEqual(plan.unmatched, ["pre"], "only the honestly-changed preamble is unmatched");
        for (let i = 1; i < 12; i++) assert.deepEqual(plan.claims.get(old[i]!.id), [`g1_${i}`]);
        assert.equal(plan.byTwin, 0, "positional coverage leaves nothing for the twin pass");
    });

    test("replacement island mid-history: resync claims both flanks, the island stays honestly unmatched", () => {
        const old = history();
        const next = remint(old, "g1");
        next[6] = msg("g1_6", "user", "EDITED: content genuinely changed"); // index 6 island
        const { plan } = { plan: planFor(old, next, storedOf(old)) };
        // island test: both the head and the tail scan legitimately re-cross
        // the same island — each crossing is one resync, so expect both.
        assert.ok(plan.resyncs >= 1, `expected resyncs, got ${plan.resyncs}`);
        assert.equal(plan.byPos, 11);
        assert.deepEqual(plan.unmatched, ["t3"], "the edited island's old id (index 6) is the only loss");
        assert.deepEqual(plan.claims.get("end"), ["g1_11"], "the tail span past the island keeps coverage");
    });

    test("insertion (net offset) still lands on the flank scans — resync never mispairs shifted cells", () => {
        const old = history();
        const switched = remint(old, "g1");
        const next = [...switched.slice(0, 5), msg("ins_0", "user", "brand new inserted turn"), ...switched.slice(5)];
        const plan = planFor(old, next, storedOf(old));
        assert.equal(plan.byPos, 12, "head + tail flanks absorb the offset; every old id keeps coverage");
        assert.equal(plan.unmatched.length, 0);
    });
});

describe("Pass 1.5 tool-id twin claiming (#2396 → #2915)", () => {
    test("no stored copy: re-minted toolCallIds with identical content are claimed by the twin pass", () => {
        const old = history();
        const next = remint(old, "g1"); // byte-identical content, every id (incl. tool ids) rewritten
        const plan = planFor(old, next, undefined); // pre-#2480 fallback: no positional copy
        assert.equal(plan.byTwin, 3, "the three tool anchors pair onto content-identical twins");
        assert.equal(plan.byTool, 0, "rewritten ids defeat the toolCallId fast path");
        assert.equal(plan.unmatched.length, 0, "prose falls to byNorm — nothing is lost");
        assert.deepEqual(plan.claims.get("t1"), ["g1_2"]);
        assert.deepEqual(plan.claims.get("t3"), ["g1_6"]);
    });

    test("genuinely re-run tool call (different content) is NEVER claimed", () => {
        const oldCall = msg("tc1", "assistant", '{"status":"3 failed"}', { contentType: "tool-call", toolName: "build", toolCallId: "call_a|fc_0" });
        const rerun = msg("tc1-new", "assistant", '{"status":"all green"}', { contentType: "tool-call", toolName: "build", toolCallId: "call_b_fc_0" });
        const order = ["tc1"];
        const anchors = { tc1: anchorOf(oldCall) };
        const plan = planReconciliation(order, anchors, [rerun], new Set(order));
        assert.equal(plan.byTwin, 0);
        assert.deepEqual(plan.unmatched, ["tc1"], "90%-similar-but-different content must not be asserted by a summary");
        assert.equal(plan.idRewriteSuspects, 0);
    });

    test("duplicate families pair k-th to k-th in conversation order", () => {
        const mk = (id: string, callId: string): CoreMessage =>
            msg(id, "user", "ok", { contentType: "tool-result", toolName: "probe", toolCallId: callId });
        const old = [mk("a1", "call_a|1"), msg("mid", "user", "between"), mk("a2", "call_a|2")];
        const next = [mk("b1", "call_b_1"), msg("mid", "user", "between"), mk("b2", "call_b_2")];
        const plan = planFor(old, next, undefined);
        assert.equal(plan.byTwin, 2);
        assert.deepEqual(plan.claims.get("a1"), ["b1"], "first anchor → first twin");
        assert.deepEqual(plan.claims.get("a2"), ["b2"], "second anchor → second twin");
    });
});

describe("escalation semantics (#2915) — the #2821 death spiral stays closed", () => {
    test("three consecutive re-mint drifts: folds keep repairing, never escalate, never reap", () => {
        const originals = history();
        const session = fakeSession(originals.map((m) => m.id as string));
        const logs: { level: string; msg: string }[] = [];
        const log = (level: string, m: string) => logs.push({ level, msg: m });
        reconcileFoldCoverage(session, originals, opts(log)); // steady: seeds anchors/order/positions

        for (const gen of ["g1", "g2", "g3"]) {
            const drifted = remint(originals, gen, true, `new request on ${gen}`);
            const r = reconcileFoldCoverage(session, drifted, opts(log));
            assert.equal(r.kind, "reanchored");
            assert.equal(r.byPos, 11, `${gen}: order carries the whole re-mint`);
            assert.equal(r.unmatched, 1, `${gen}: only the changed preamble id is honest loss`);
            assert.equal(r.reaped, 0, `${gen}: no zombie reap`);
        }
        assert.ok(!logs.some((l) => l.msg.includes("compression substrate appears destroyed")),
            "the #2821 verdict must never fire for re-mint churn");
        assert.ok(session.metadata.foldDriftEscalated === undefined, "escalation latch never sets");
        assert.ok(session.metadata.foldDriftStreak === undefined || session.metadata.foldDriftStreak === 0,
            "claims every pass keep the streak reset");
        assert.ok(logs.some((l) => l.msg.includes("order break(s) resynced")), "resync is observable in the drift line");
        // the fold rides the newest generation's ids — coverage survived three model switches
        const covered = (session.state.blocks as { effectiveMessageIds: string[] }[])[0].effectiveMessageIds;
        for (let i = 1; i < 12; i++) assert.ok(covered.includes(`g3_${i}`), `g3_${i} covered`);
        assert.ok(covered.includes("pre"), "the honestly-lost preamble id stays listed (warn, not destroy)");
    });

    test("without the positional copy (pre-#2480 upgrade path) the twin pass alone prevents the spiral", () => {
        const originals = history();
        const session = fakeSession(originals.map((m) => m.id as string));
        const logs: { level: string; msg: string }[] = [];
        reconcileFoldCoverage(session, originals, opts());
        delete (session.metadata as Record<string, unknown>).foldPositions;
        // h1 rides the twin pass (no stored copy); its own pass SAVES a fresh
        // {ids, canon} copy, so h2/h3 upgrade to the positional path — the
        // order-centric system self-heals its evidence after one churn.
        const r1 = reconcileFoldCoverage(session, remint(originals, "h1", true, "req h1"), opts((l, m) => logs.push({ level: l, msg: m })));
        assert.equal(r1.byTwin, 3, "h1: all tool anchors recovered via twins");
        assert.equal(r1.unmatched, 1, "h1: only the changed preamble");
        for (const gen of ["h2", "h3"]) {
            const r = reconcileFoldCoverage(session, remint(originals, gen, true, `req ${gen}`), opts((l, m) => logs.push({ level: l, msg: m })));
            assert.equal(r.byPos, 11, `${gen}: positional copy regenerated — order carries the re-mint`);
            assert.equal(r.unmatched, 1, `${gen}: only the changed preamble`);
        }
        assert.ok(!logs.some((l) => l.msg.includes("compression substrate appears destroyed")));
    });
});
