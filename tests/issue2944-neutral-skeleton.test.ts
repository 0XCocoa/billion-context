// #2944: order-primary session resolution — pinned against the old fp ladder
// (characterization-first, differential corpus).
//
// The SAME scenario corpus runs through BOTH implementations:
//   OLD: src/persona-anchor.ts (the fp ladder — behavior pinned FIRST as the
//        瞄点 against the current file, untouched by this PR)
//   NEW: src/session-resolve.ts (order+id claim on the wire-neutral domain;
//        skeleton = neutralTurns kinds; rule-3 fragment guard on the two
//        order-ambiguous corners; skeleton-hash task keys)
// Rows where the two agree share one expectation; designed divergences are
// marked old→new with the #2944 principle that justifies them.
//
// Special proofs (特殊代码证明):
//   P1 50% mid-conversation content churn, same order + length → SAME
//      session (old: raw via chain-forgiven migrate; new: continue — the
//      skeleton never saw the churn).
//   P2 shallow blob under a claimed id → NEVER raw (old: fork |sub:<fp>;
//      new: derived-aux |sub:aux).
//   P3 genuine head truncation (verbatim surviving tail) → raw + reanchor
//      (old: raw via fp-equal rescue; new: fragment-verified reanchor).
//   P4 growth → continue raw (both).
//   P5 deep main-shaped stranger → derived-task, skeleton-hash key, stable
//      across replays.
//   P6 cross-wire: the same logical conversation on all four wires yields
//      the IDENTICAL skeleton and resolution sequence (claim on wire A,
//      growth on B/C/D → continue) — impossible for any raw-field classifier.
//   P7 host machinery immunity: leading-system add/remove + "[model changed:
//      …]" marker-turn injection leave the skeleton unchanged and the
//      resolution continuing.
//   P8 mixed traffic under ONE main id: subagent replays (#150 id reuse —
//      shorter, alternating tail) never steal the raw key; the fragment guard
//      routes them to distinct |sub:task:<skel8> lanes while genuine
//      truncation stays raw and the main conversation continues.
//   A1 claim timing (granularity shift, old→new): the old ladder claims on
//      FIRST SIGHT of any non-empty system (req1 of a brand-new
//      conversation); the new resolver requires the main SHAPE (≥3 turns
//      incl. assistant) — req1/req2 derive |sub:aux, req3 claims.
//   A1b blob-first race (#1916/#2156): a review blob arriving before any
//      main turn steals the raw anchor in the old ladder (main then forks
//      absent a persisted chain); the new resolver structurally cannot hand
//      it the raw key.
//   A3 zero-assistant truncation: a claimed id whose resend carries NO
//      assistant turns derives (guard beats id trust — a gutted main tail
//      and a blob are shape-indistinguishable).

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hermetic dirs BEFORE imports (same idiom as the issue2601 suite).
const XDG = mkdtempSync(join(tmpdir(), "issue2944ework-"));
process.env.XDG_DATA_HOME = join(XDG, "data");
process.env.XDG_STATE_HOME = join(XDG, "state");
process.env.BILI_PERSIST = "0";
process.env.NODE_ENV = "test";

const { prefixAffinity } = await import("../src/prefix-affinity.ts");
const { resetPersonaAnchorsForTest, resolvePersonaKey, personaAnchorOf } = await import("../src/persona-anchor.ts");
const { resolveSessionOrder, resetSessionOrderForTest, sessionOrderSkeletonOf, orderSkeletonOf } = await import("../src/session-resolve.ts");
import type { SessionOrderResolution } from "../src/session-resolve.ts";

const sha = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);
const skel8 = (kinds: string[]): string => createHash("sha256").update(kinds.join("\u0000")).digest("hex").slice(0, 8);

type Msg = { role: string; content: string };

/** Alternating user/assistant text turns, ~120 chars each. */
function msgs(n: number, tag = "m"): Msg[] {
    const out: Msg[] = [];
    for (let i = 0; i < n; i++) {
        const role = i % 2 === 0 ? "user" : "assistant";
        out.push({ role, content: `${tag} #${i} — ${tag} message body with enough prose to be a realistic cell ${"x".repeat(80)}` });
    }
    return out;
}

/** Rewrites every even-indexed message's content (50% churn); roles/order/
 *  length unchanged. */
function churn50(list: Msg[]): Msg[] {
    return list.map((m, i) => (i % 2 === 0 ? { ...m, content: `REWRITTEN ${i}: completely different words, same slot ${"y".repeat(80)}` } : m));
}

// Shared system inputs — the NEW resolver never receives them; they exist so
// the corpus is identical for the OLD run.
const BASE_SYSTEM = "You are dsh, a desktop shell agent. " + "ambient config line. ".repeat(40);
const DRIFTED_SYSTEM = BASE_SYSTEM.replace("ambient config line.", "ambient config line (v2 with more words).");
const REVIEW_SYSTEM = "You are an automated reviewer. Output only XML verdict tags.";
const conv = "session-2944ework";

function seedChain(id: string, chain: Msg[]): void {
    resetPersonaAnchorsForTest();
    prefixAffinity.forget(id);
    const fp = prefixAffinity.chainFingerprint(chain);
    if (fp) prefixAffinity.note(id, fp.depth, fp.tailHash, fp.itemHashes, true);
}

// ---------------------------------------------------------------------------
// OLD resolver: characterization pins (瞄点) — current ladder, untouched.
test("old ladder: characterization pins", () => {
    // S1: first sight claims raw.
    seedChain(conv, msgs(6, "seed"));
    assert.equal(resolvePersonaKey(conv, BASE_SYSTEM, msgs(6, "seed")).key, conv);

    // S2: fp equal → match raw.
    assert.equal(resolvePersonaKey(conv, BASE_SYSTEM, msgs(10, "seed")).key, conv);

    // S3: fp drift + chain continues → migrate raw (anchor moves).
    const s3 = resolvePersonaKey(conv, DRIFTED_SYSTEM, msgs(10, "seed"));
    assert.equal(s3.key, conv);
    assert.equal(s3.action, "migrate");

    // S4: fp drift + 50% content churn + chain continues → still raw (the
    //     ladder keys REPRESENTATION and forgives via chain continuity).
    assert.equal(resolvePersonaKey(conv, DRIFTED_SYSTEM, churn50(msgs(10, "seed"))).key, conv);

    // S5: truncated history under the same id, fp equal → raw (fp-equal
    //     rescue — truncation never consulted).
    assert.equal(resolvePersonaKey(conv, DRIFTED_SYSTEM, msgs(6, "seed").slice(3)).key, conv);

    // S6: review blob under a claimed id → fork |sub:<fp>.
    const blob = msgs(1, "review-blob").map((m) => ({ ...m, role: "user" }));
    assert.equal(resolvePersonaKey(conv, REVIEW_SYSTEM, blob).key, `${conv}|sub:${sha(REVIEW_SYSTEM)}`);
});

// Acceptance ① names the #2601 combination explicitly — pin it in the
// differential corpus too (the dedicated suite covers it repo-wide).
test("old ladder: #2601 model-drift absorption pin", () => {
    const SYS_A = ["You are dsh.", "Current model: glm-5.3.", "Ambient filler line."].join("\n");
    const SYS_B = ["You are dsh.", "Model line recomputed: glm-5.3 -> glm-5.2.", "Ambient filler line."].join("\n");
    const id = "conv-2601-pin";
    resetPersonaAnchorsForTest();
    assert.equal(resolvePersonaKey(id, SYS_A, msgs(4, "m"), "glm-5.3").action, "claim");
    // Header-corroborated drift: the only changed line names BOTH models →
    // absorbed as a model switch, anchor migrates, raw key kept.
    const r = resolvePersonaKey(id, SYS_B, msgs(4, "m"), "glm-5.2");
    assert.equal(r.key, id);
    assert.equal(r.action, "migrate-model");
    assert.equal(personaAnchorOf(id), sha(SYS_B));
    // Negative control: a changed line naming NEITHER model keeps the fork
    // conjunction intact.
    const id2 = "conv-2601-neg";
    const SYS_C = ["You are dsh.", "Editor config updated (unrelated).", "Ambient filler line."].join("\n");
    resetPersonaAnchorsForTest();
    resolvePersonaKey(id2, SYS_A, msgs(4, "m"), "glm-5.3");
    const r2 = resolvePersonaKey(id2, SYS_C, msgs(4, "m"), "glm-5.2");
    assert.equal(r2.action, "fork");
    assert.equal(r2.key, `${id2}|sub:${sha(SYS_C)}`);
});

// ---------------------------------------------------------------------------
// NEW resolver: same corpus, order+id semantics.
test("new resolver: same corpus, order+id semantics", () => {
    resetSessionOrderForTest();

    // S1: first sight, main-shaped → claim raw.
    assert.equal(resolveSessionOrder(conv, msgs(6, "seed")).key, conv);

    // S2/P4: growth → continue raw.
    const s2 = resolveSessionOrder(conv, msgs(10, "seed"));
    assert.equal(s2.key, conv);
    assert.equal(s2.action, "continue");

    // S3 (old→new divergence): system drift is INVISIBLE to the new
    // resolver — it takes no system input at all; identical history →
    // continue (the old ladder had to MIGRATE through chain continuity to
    // reach the same key).
    const s3: SessionOrderResolution = resolveSessionOrder(conv, msgs(10, "seed"));
    assert.equal(s3.key, conv);
    assert.equal(s3.action, "continue");

    // S4/P1: 50% content churn, same order + length → SAME session. The
    // recorded skeleton is content-blind; the churn leaves it byte-identical
    // (old→new: the old ladder needed the chainContinues rescue → migrate).
    const s4 = resolveSessionOrder(conv, churn50(msgs(10, "seed")));
    assert.equal(s4.key, conv);
    assert.equal(s4.action, "continue");
    assert.deepEqual(sessionOrderSkeletonOf(conv), orderSkeletonOf(msgs(10, "seed")));

    // S5/P3: genuine head truncation — a VERBATIM suffix of the recorded
    // history (what native compaction actually produces) → the fragment
    // guard passes → raw + reanchor (old: raw via fp-equal rescue — same
    // key, different mechanism).
    const s5 = resolveSessionOrder(conv, churn50(msgs(10, "seed")).slice(7));
    assert.equal(s5.key, conv);
    assert.equal(s5.action, "reanchor");
    assert.deepEqual(sessionOrderSkeletonOf(conv), orderSkeletonOf(churn50(msgs(10, "seed")).slice(7)));

    // S6/P2: shallow blob under a claimed id → derived-aux (old→new: fork
    // |sub:<fp> → fixed |sub:aux; the fp no longer exists anywhere).
    const blob = msgs(1, "review-blob").map((m) => ({ ...m, role: "user" }));
    const s6 = resolveSessionOrder(conv, blob);
    assert.equal(s6.key, `${conv}|sub:aux`);
    assert.equal(s6.action, "derived-aux");
});

// P5 guard rail: deep main-shaped history sharing NOTHING with the recorded
// skeleton → derived-task, never raw. The task key is discriminated by
// skeleton hash: two different strangers never share one compression
// session, the same stranger replays stable.
test("P5: deep main-shaped stranger → derived-task (skeleton-hash key)", () => {
    resetSessionOrderForTest();
    resolveSessionOrder(conv, msgs(8, "seed"));
    const stranger: Msg[] = [];
    const roles = ["user", "user", "user", "assistant", "user", "assistant", "user", "assistant", "assistant"];
    roles.forEach((r, i) => stranger.push({ role: r, content: `stranger ${i} ${"z".repeat(60)}` }));
    const res = resolveSessionOrder(conv, stranger);
    assert.equal(res.action, "derived-task");
    assert.equal(res.key, `${conv}|sub:task:${skel8(orderSkeletonOf(stranger))}`);
    // The same stranger replaying across passes keeps a STABLE key.
    assert.equal(resolveSessionOrder(conv, stranger).key, res.key);
});

// ---------------------------------------------------------------------------
// P8: mixed traffic under ONE main id. Two holes the order-only draft had:
//   (a) a codex-style subagent replay (#150 id reuse) is SHORTER with an
//       alternating tail that ALIGNs — order-identical to genuine head
//       truncation. Only the tail CONTENT fragments separate them: genuine
//       compaction keeps the old tail messages verbatim (frags equal), a
//       subagent carries different content (frags differ).
//   (b) two different subagents under one main id must not collide on one
//       task key — the skeleton-hash discriminator splits them.
test("P8: mixed traffic — subagent replays never steal the raw key", () => {
    resetSessionOrderForTest();
    const main = msgs(7, "seed"); // u a u a u a u
    assert.equal(resolveSessionOrder(conv, main).action, "claim");

    // Subagent A: shorter, tail aligns by alternation, different content →
    // the fragment guard fails the raw branch → derived-task.
    const subA: Msg[] = [
        { role: "user", content: `subagent question about the codebase ${"s".repeat(80)}` },
        { role: "assistant", content: `subagent answer ${"s".repeat(80)}` },
        { role: "user", content: `subagent follow-up ${"s".repeat(80)}` },
    ];
    const rA = resolveSessionOrder(conv, subA);
    assert.equal(rA.action, "derived-task");
    assert.equal(rA.key, `${conv}|sub:task:${skel8(orderSkeletonOf(subA))}`);
    // Replay of the SAME subagent keeps the stable key.
    assert.equal(resolveSessionOrder(conv, subA).key, rA.key);

    // Subagent B: a different shape → a DISTINCT task key (no collision).
    const subB: Msg[] = [
        { role: "user", content: `second subagent ${"w".repeat(80)}` },
        { role: "user", content: `more context ${"w".repeat(80)}` },
        { role: "assistant", content: `second answer ${"w".repeat(80)}` },
        { role: "user", content: `second follow-up ${"w".repeat(80)}` },
        { role: "assistant", content: `done ${"w".repeat(80)}` },
    ];
    const rB = resolveSessionOrder(conv, subB);
    assert.equal(rB.action, "derived-task");
    assert.notEqual(rB.key, rA.key);

    // Aux title/auto-review traffic → derived-aux, never raw.
    const aux: Msg[] = [{ role: "user", content: `generate a title for this conversation ${"t".repeat(80)}` }];
    const rAux = resolveSessionOrder(conv, aux);
    assert.equal(rAux.action, "derived-aux");
    assert.equal(rAux.key, `${conv}|sub:aux`);

    // The main conversation keeps flowing on the raw key through all of it.
    const rMain = resolveSessionOrder(conv, msgs(9, "seed"));
    assert.equal(rMain.action, "continue");
    assert.equal(rMain.key, conv);

    // Genuine truncation (dsh native compaction): head cut, surviving tail
    // messages VERBATIM → fragment guard passes → raw + reanchor.
    const truncated = msgs(9, "seed").slice(6);
    const rTr = resolveSessionOrder(conv, truncated);
    assert.equal(rTr.action, "reanchor");
    assert.equal(rTr.key, conv);
});

// ---------------------------------------------------------------------------
// A1 (added row): claim timing — the granularity shift, pinned so nobody
// fiddles the threshold silently.
test("A1: claim timing — old claims on first sight, new requires the main shape (old→new)", () => {
    const sys = { role: "system", content: BASE_SYSTEM };
    const user1 = { role: "user", content: "hello agent" };
    const req1 = [sys, user1];
    const req2 = [...req1, { role: "assistant", content: "hi, how can I help" }];
    const req3 = [...req2, { role: "user", content: "list the files" }];
    // OLD: any non-empty system on first sight claims the raw anchor — req1
    // already owns the key (this is the #1916 exposure point).
    resetPersonaAnchorsForTest();
    assert.equal(resolvePersonaKey("timing-old", BASE_SYSTEM, [user1]).key, "timing-old");
    // NEW: the skeleton strips the system run — req1 is 1 turn, req2 is 2
    // (<3, main shape not yet established): both derive |sub:aux; req3
    // (3 turns incl. assistant) claims.
    resetSessionOrderForTest();
    const id = "timing-new";
    assert.equal(resolveSessionOrder(id, req1).action, "derived-aux");
    assert.equal(resolveSessionOrder(id, req2).action, "derived-aux");
    const c = resolveSessionOrder(id, req3);
    assert.equal(c.action, "claim");
    assert.equal(c.key, id);
    assert.deepEqual(sessionOrderSkeletonOf(id), ["user", "assistant", "user"]);
});

// A1b (added row): the blob-first race the old ladder structurally had.
test("A1b: blob-first race (#1916/#2156) — old lets the blob steal the raw anchor, new cannot", () => {
    const blob: Msg[] = [{ role: "user", content: `[review request] assess the latest change ${"r".repeat(80)}` }];
    // OLD: the racing blob arrives first under the virgin id and CLAIMS the
    // raw anchor (REVIEW system); the first main turn then forks onto
    // |sub:<fp(main)> — the ghost-fork shape, absent a persisted chain to
    // self-heal through.
    resetPersonaAnchorsForTest();
    const id = "race-old";
    assert.equal(resolvePersonaKey(id, REVIEW_SYSTEM, blob).key, id); // stolen
    const forked = resolvePersonaKey(id, BASE_SYSTEM, msgs(4, "main"));
    assert.equal(forked.action, "fork");
    assert.equal(forked.key, `${id}|sub:${sha(BASE_SYSTEM)}`);
    // NEW: the blob can only ever take |sub:aux and records NOTHING under
    // the raw id; the main conversation that follows claims raw cleanly.
    resetSessionOrderForTest();
    const id2 = "race-new";
    assert.equal(resolveSessionOrder(id2, blob).key, `${id2}|sub:aux`);
    assert.equal(sessionOrderSkeletonOf(id2), undefined);
    const m = resolveSessionOrder(id2, msgs(4, "main"));
    assert.equal(m.action, "claim");
    assert.equal(m.key, id2);
});

// A3 (added row): guard beats id trust when the shapes are indistinguishable.
test("A3: zero-assistant truncation under a claimed id derives", () => {
    resetSessionOrderForTest();
    const id = "gutted";
    resolveSessionOrder(id, msgs(8, "s")); // claim, 8 turns recorded
    // Aggressive compaction that ate every assistant turn: the resend is a
    // summary blob + the latest prompt — no assistant anywhere. Shape-
    // indistinguishable from aux traffic → derived, never raw; the recorded
    // skeleton survives untouched.
    const gutted: Msg[] = [
        { role: "user", content: `compaction summary of the folded prefix ${"c".repeat(80)}` },
        { role: "user", content: `latest prompt ${"c".repeat(80)}` },
    ];
    const r = resolveSessionOrder(id, gutted);
    assert.equal(r.action, "derived-aux");
    assert.equal(r.key, `${id}|sub:aux`);
    assert.deepEqual(sessionOrderSkeletonOf(id), orderSkeletonOf(msgs(8, "s")));
});

// Aux traffic FIRST (before any main claim) must never claim raw.
test("shallow-first: aux blob on a virgin id never claims, later main does", () => {
    resetSessionOrderForTest();
    const blob = msgs(1, "x").map((m) => ({ ...m, role: "user" }));
    const res = resolveSessionOrder("virgin", blob);
    assert.equal(res.action, "derived-aux");
    assert.equal(res.key, "virgin|sub:aux");
    // The blob records NOTHING under the raw id — only a main-shaped
    // history may establish the skeleton.
    assert.equal(sessionOrderSkeletonOf("virgin"), undefined);
    // And the main conversation arriving afterwards still claims raw.
    const main = resolveSessionOrder("virgin", msgs(6, "main"));
    assert.equal(main.action, "claim");
    assert.equal(main.key, "virgin");
    assert.deepEqual(sessionOrderSkeletonOf("virgin"), orderSkeletonOf(msgs(6, "main")));
});

// Skeleton is content-blind by construction: kinds of a churned history are
// identical to the original, and tool turns are their own skeleton cells on
// every wire (shape, not content — tool name/args live outside the kind).
test("orderSkeletonOf ignores content, keeps role/tool shape", () => {
    const a = msgs(6, "seed");
    assert.deepEqual(orderSkeletonOf(a), orderSkeletonOf(churn50(a)));
    const openaiTool = [
        { role: "user", content: "list the files" },
        { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "bash", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: "ok" },
        { role: "assistant", content: "done" },
    ];
    const anthropicTool = [
        { role: "user", content: [{ type: "text", text: "list the files" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "ok" }] },
        { role: "assistant", content: [{ type: "text", text: "done" }] },
    ];
    assert.deepEqual(orderSkeletonOf(openaiTool), ["user", "assistant", "tool", "assistant"]);
    assert.deepEqual(orderSkeletonOf(anthropicTool), ["user", "assistant", "tool", "assistant"]);
});

// ---------------------------------------------------------------------------
// P6: the SAME logical conversation, rendered on all four wires, yields the
// IDENTICAL skeleton — and the resolution sequence is identical (claim on
// wire A, GROW on wire B/C/D → continue). Any raw-field classifier produces
// per-wire kind strings ("assistant:tool_use" vs "assistant:tool_calls")
// and can never pass this proof.
test("P6: cross-wire — same conversation, four renderings, one skeleton", () => {
    // Logical conversation: u0 a0 u1 A(tool c1) T(c1) a2 u3 a3
    const openai = [
        { role: "user", content: "u0 question" },
        { role: "assistant", content: "a0 answer" },
        { role: "user", content: "u1 run the tool" },
        { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "bash", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: "ok" },
        { role: "assistant", content: "a2 done" },
        { role: "user", content: "u3 follow up" },
        { role: "assistant", content: "a3 final" },
    ];
    const anthropic = [
        { role: "user", content: [{ type: "text", text: "u0 question" }] },
        { role: "assistant", content: [{ type: "text", text: "a0 answer" }] },
        { role: "user", content: [{ type: "text", text: "u1 run the tool" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "ok" }] },
        { role: "assistant", content: [{ type: "text", text: "a2 done" }] },
        { role: "user", content: [{ type: "text", text: "u3 follow up" }] },
        { role: "assistant", content: [{ type: "text", text: "a3 final" }] },
    ];
    const google = [
        { role: "user", parts: [{ text: "u0 question" }] },
        { role: "model", parts: [{ text: "a0 answer" }] },
        { role: "user", parts: [{ text: "u1 run the tool" }] },
        { role: "model", parts: [{ functionCall: { name: "bash", args: {} } }] },
        { role: "user", parts: [{ functionResponse: { response: { output: "ok" } } }] },
        { role: "model", parts: [{ text: "a2 done" }] },
        { role: "user", parts: [{ text: "u3 follow up" }] },
        { role: "model", parts: [{ text: "a3 final" }] },
    ];
    const responses = [
        { type: "message", role: "user", content: "u0 question" },
        { type: "message", role: "assistant", content: "a0 answer" },
        { type: "message", role: "user", content: "u1 run the tool" },
        { type: "function_call", call_id: "c1", name: "bash", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "ok" },
        { type: "message", role: "assistant", content: "a2 done" },
        { type: "message", role: "user", content: "u3 follow up" },
        { type: "message", role: "assistant", content: "a3 final" },
    ];
    const expected = ["user", "assistant", "user", "assistant", "tool", "assistant", "user", "assistant"];
    assert.deepEqual(orderSkeletonOf(openai), expected);
    assert.deepEqual(orderSkeletonOf(anthropic), expected);
    assert.deepEqual(orderSkeletonOf(google), expected);
    assert.deepEqual(orderSkeletonOf(responses), expected);

    // Identity across wires: claim on wire A, GROW on wire B/C/D → continue
    // (a stateless client switched protocol mid-conversation — #2791's
    // scenario — keeps the raw key and its fold ledger).
    resetSessionOrderForTest();
    const id = "cross-wire-conv";
    assert.equal(resolveSessionOrder(id, openai).action, "claim");
    const grownAnthropic = [...anthropic, { role: "user", content: [{ type: "text", text: "u4 next" }] }, { role: "assistant", content: [{ type: "text", text: "a4" }] }];
    const res = resolveSessionOrder(id, grownAnthropic);
    assert.equal(res.action, "continue");
    assert.equal(res.key, id);
    const grownGoogle = [...google, { role: "user", parts: [{ text: "u4 next" }] }, { role: "model", parts: [{ text: "a4" }] }];
    assert.equal(resolveSessionOrder(id, grownGoogle).action, "continue");
    const grownResponses = [...responses, { type: "message", role: "user", content: "u4 next" }, { type: "message", role: "assistant", content: "a4" }];
    assert.equal(resolveSessionOrder(id, grownResponses).action, "continue");
});

// ---------------------------------------------------------------------------
// P7: host machinery must not move the skeleton — leading-system add/remove
// and client-marker turn injection are projection-level noise.
test("P7: leading-system add/remove + client-marker turn leave the skeleton unchanged", () => {
    const base = msgs(6, "seed");
    const withSystem = [
        { role: "system", content: "You are dsh. " + "harness state: date cwd budget. ".repeat(20) },
        ...base,
    ];
    const withMarker = [
        ...base.slice(0, 4),
        { role: "user", content: "[model changed: glm-5.3 → qwen3.8-27b]" },
        ...base.slice(4),
    ];
    assert.deepEqual(orderSkeletonOf(withSystem), orderSkeletonOf(base));
    assert.deepEqual(orderSkeletonOf(withMarker), orderSkeletonOf(base));

    // And the resolver agrees: claim the base, then arrive with system rows
    // and a marker turn injected → continue (an order-only raw-field
    // skeleton would misalign and derive a task lane here).
    resetSessionOrderForTest();
    const id = "machinery-conv";
    assert.equal(resolveSessionOrder(id, base).action, "claim");
    const res = resolveSessionOrder(id, [...withSystem.slice(0, 1), ...withMarker]);
    assert.equal(res.action, "continue");
    assert.equal(res.key, id);
});
