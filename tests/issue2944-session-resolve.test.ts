// #2944: order-primary session resolution — differential pin.
//
// The SAME scenario corpus runs through BOTH implementations:
//   OLD: src/persona-anchor.ts (the fp ladder — behavior pinned FIRST as
//        the 瞄点; these assertions must pass against the current file
//        untouched)
//   NEW: src/session-resolve.ts (order+id claim; content-blind skeleton)
// Rows where the two agree share one expectation; designed divergences
// are marked old→new with the #2944 principle that justifies them.
//
// Special proofs (特殊代码证明) required by the owner:
//   P1 50% mid-conversation content churn, same order + same length →
//      SAME session (new: continue raw; old: match raw via fp-equal).
//   P2 shallow review blob under a claimed id → NEVER claims raw
//      (old: fork |sub:fp; new: derived-aux |sub:aux — #1916 race dead).
//   P3 head truncation (native compaction) under same id → raw +
//      re-anchor (old: match raw via fp-equal rescue; new: reanchor).
//   P4 system/tool prompt drift + same chain → raw (old: migrate #2241 /
//      #2942 match; new: continue — system text is not read at all).
//   P5 deep main-shaped history sharing nothing with the recorded
//      skeleton → derived, not raw (guard rail).

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hermetic dirs BEFORE imports (same idiom as issue2601 suite).
const XDG = mkdtempSync(join(tmpdir(), "issue2944-"));
process.env.XDG_DATA_HOME = join(XDG, "data");
process.env.XDG_STATE_HOME = join(XDG, "state");
process.env.BILI_PERSIST = "0";
process.env.NODE_ENV = "test";

const { prefixAffinity } = await import("../src/prefix-affinity.ts");
const { resetPersonaAnchorsForTest, resolvePersonaKey } = await import("../src/persona-anchor.ts");
import { resolveSessionOrder, resetSessionOrderForTest, orderKindsOf, orderKindOf, sessionOrderSkeletonOf, type SessionOrderResolution } from "../src/session-resolve.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

type Msg = { role: string; content: string };

/** Alternating user/assistant turns, ~120 chars each. */
function msgs(n: number, tag = "m"): Msg[] {
    const out: Msg[] = [];
    for (let i = 0; i < n; i++) {
        const role = i % 2 === 0 ? "user" : "assistant";
        out.push({ role, content: `${tag} #${i} — ${tag} message body with enough prose to be a realistic cell ${"x".repeat(80)}` });
    }
    return out;
}

/** Rewrites the content of every even-indexed message (50% churn) while
 *  keeping roles, order and length identical. */
function churn50(list: Msg[]): Msg[] {
    return list.map((m, i) => (i % 2 === 0 ? { ...m, content: `REWRITTEN ${i}: completely different words, same slot ${"y".repeat(80)}` } : m));
}

// Shared system inputs (the new resolver never reads them — they exist for
// the OLD run to keep the corpus identical).
const BASE_SYSTEM = "You are dsh, a desktop shell agent. " + "ambient config line. ".repeat(40);
const DRIFTED_SYSTEM = BASE_SYSTEM.replace("ambient config line.", "ambient config line (v2 with more words).");
const REVIEW_SYSTEM = "You are an automated reviewer. Output only XML verdict tags.";
const conv = "session-2944";

function seedChain(conv: string, chain: Msg[]) {
    resetPersonaAnchorsForTest();
    prefixAffinity.forget(conv);
    const fp = prefixAffinity.chainFingerprint(chain);
    if (fp) prefixAffinity.note(conv, fp.depth, fp.tailHash, fp.itemHashes, true);
}

// ---------------------------------------------------------------------------
// OLD resolver: run the corpus against persona-anchor, seeded per scenario
// so each characterization expectation is exactly the current ladder's.
test("old ladder: characterization pins (瞄点)", async (t) => {
    // S1: first sight claims raw.
    seedChain(conv, msgs(6, "seed"));
    assert.equal(resolvePersonaKey(conv, BASE_SYSTEM, msgs(6, "seed")).key, conv);

    // S2: fp equal → match raw.
    assert.equal(resolvePersonaKey(conv, BASE_SYSTEM, msgs(10, "seed")).key, conv);

    // S3: fp drift + chain continues → migrate raw (anchor moves).
    assert.equal(resolvePersonaKey(conv, DRIFTED_SYSTEM, msgs(10, "seed")).key, conv);

    // S4: fp equal → match raw even though 50% of contents churned.
    assert.equal(resolvePersonaKey(conv, DRIFTED_SYSTEM, churn50(msgs(10, "seed"))).key, conv);

    // S5: fp equal → match raw for truncated history.
    assert.equal(resolvePersonaKey(conv, DRIFTED_SYSTEM, msgs(6, "seed").slice(3)).key, conv);

    // S6: review blob → fork |sub:<fp>.
    const blob = msgs(1, "review-blob").map((m) => ({ ...m, role: "user" }));
    assert.equal(resolvePersonaKey(conv, REVIEW_SYSTEM, blob).key, `${conv}|sub:${sha(REVIEW_SYSTEM)}`);
});

// ---------------------------------------------------------------------------
// NEW resolver: same inputs, order+id semantics.
test("new resolver: same corpus, order+id semantics", async (t) => {
    resetSessionOrderForTest();

    // S1: first sight, main-shaped → claim raw.
    assert.equal(resolveSessionOrder(conv, msgs(6, "seed")).key, conv);

    // S2: growth → continue raw.
    assert.equal(resolveSessionOrder(conv, msgs(10, "seed")).key, conv);

    // S3: system drift invisible (input IDENTICAL to S2) → continue raw.
    const s3 = resolveSessionOrder(conv, msgs(10, "seed"));
    assert.equal(s3.key, conv);
    assert.equal(s3.action, "continue");

    // S4 (P1): 50% content churn, same kinds → SAME session. The recorded
    // skeleton is content-blind too: the churn leaves it byte-identical.
    const s4 = resolveSessionOrder(conv, churn50(msgs(10, "seed")));
    assert.equal(s4.key, conv);
    assert.equal(s4.action, "continue");
    assert.deepEqual(sessionOrderSkeletonOf(conv), orderKindsOf(msgs(10, "seed")));

    // S5 (P3): truncated head, tail aligns → raw + reanchor; the skeleton
    // follows the host's truth (re-anchored to the truncated kinds).
    const s5: SessionOrderResolution = resolveSessionOrder(conv, msgs(6, "seed").slice(3));
    assert.equal(s5.key, conv);
    assert.equal(s5.action, "reanchor");
    assert.deepEqual(sessionOrderSkeletonOf(conv), orderKindsOf(msgs(6, "seed").slice(3)));

    // S6 (P2): shallow blob under claimed id → derived-aux.
    const blob = msgs(1, "review-blob").map((m) => ({ ...m, role: "user" }));
    const s6 = resolveSessionOrder(conv, blob);
    assert.equal(s6.key, `${conv}|sub:aux`);
    assert.equal(s6.action, "derived-aux");
});

// ---------------------------------------------------------------------------
// P5 guard rail: deep main-shaped history sharing NOTHING with the recorded
// skeleton under the same id → derived-task, never raw.
test("P5: deep main-shaped stranger → derived-task", () => {
    resetSessionOrderForTest();
    resolveSessionOrder(conv, msgs(8, "seed"));
    // Different parity shape AND different length growth mismatch: build a
    // history whose kind sequence diverges from position 1 and never
    // re-aligns in the tail window.
    const stranger: Msg[] = [];
    const roles = ["user", "user", "user", "assistant", "user", "assistant", "user", "assistant", "assistant"];
    roles.forEach((r, i) => stranger.push({ role: r, content: `stranger ${i} ${"z".repeat(60)}` }));
    const res = resolveSessionOrder(conv, stranger);
    assert.equal(res.key, `${conv}|sub:task`);
    assert.equal(res.action, "derived-task");
});

// Aux traffic FIRST (before any main claim) must never claim raw.
test("shallow-first: aux blob on virgin id → derived-aux, raw unclaimed", () => {
    resetSessionOrderForTest();
    const blob = msgs(1, "x").map((m) => ({ ...m, role: "user" }));
    const res = resolveSessionOrder("session-virgin", blob);
    assert.equal(res.action, "derived-aux");
    assert.equal(res.key, "session-virgin|sub:aux");
    // The blob records NOTHING under the raw id — only a main-shaped
    // history may establish the skeleton.
    assert.equal(sessionOrderSkeletonOf("session-virgin"), undefined);
    // And the main conversation arriving afterwards still claims raw.
    const main = resolveSessionOrder("session-virgin", msgs(6, "main"));
    assert.equal(main.action, "claim");
    assert.equal(main.key, "session-virgin");
    assert.deepEqual(sessionOrderSkeletonOf("session-virgin"), orderKindsOf(msgs(6, "main")));
});

// Skeleton is content-blind by construction: kinds of a churned history are
// identical to the original.
test("orderKindsOf ignores content, keeps role/tool shape", () => {
    const a = msgs(6, "seed");
    const b = churn50(a);
    assert.deepEqual(orderKindsOf(a), orderKindsOf(b));
    const toolTurn = { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }] };
    const toolRes = { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] };
    assert.equal(orderKindOf(toolTurn), "assistant:tool_use");
    assert.equal(orderKindOf(toolRes), "user:tool_result");
    // OpenAI wire shape: tool_calls on the assistant, tool_call_id on the reply.
    assert.equal(orderKindOf({ role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "bash" } }] }), "assistant:tool_calls");
    assert.equal(orderKindOf({ role: "tool", content: "ok", tool_call_id: "c1" }), "tool:tool_result");
});
