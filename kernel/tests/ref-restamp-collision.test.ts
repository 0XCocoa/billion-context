import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore, defaultConfig, assignRefs, createInitialState, type CoreMessage, type CompressionState } from "../src/index.js";
import { restampRefsToLedger, emptyRefMap } from "../src/refs.js";

// #4797 phase C/B kernel pins: the ledger-alignment restamp must leave the
// superseded map free of LIVE keys (the collision band that dead-looped
// bili's compress guard), migrate the other ref-keyed block fields
// (startRef/endRef, deadRefs) onto the new numbering, and the one-time
// refLedgerAligned flag must survive the kernel's own state clones
// (syncBlocks / cloneState) — losing it re-arms the restamp every turn.

function msg(id: string): CoreMessage {
    return { id, role: "user", text: `${id} body text long enough to matter for folding decisions.` };
}

// Drifted pre-restamp shape (protected c takes no number but holds a row seq,
// pushing every later counter ref ahead of seq+1):
//   rows/seq: a=0 b=1 c=2 d=3 e=4 f=5   → targets m1 m2 (BLOCKED) m4 m5 m6
//   old refs: a=m1 b=m3 c=BLOCKED d=m4 e=m6 f=m7
// f's target m6 is e's OLD number — vacated and re-occupied in the same pass.
function driftedState(): { state: CompressionState; seq: Map<string, number> } {
    const state = createInitialState();
    const map = emptyRefMap();
    map.byRaw.a = "m00001"; map.byRef.m00001 = "a";
    map.byRaw.b = "m00003"; map.byRef.m00003 = "b";
    map.byRaw.c = "BLOCKED";
    map.byRaw.d = "m00004"; map.byRef.m00004 = "d";
    map.byRaw.e = "m00006"; map.byRef.m00006 = "e";
    map.byRaw.f = "m00007"; map.byRef.m00007 = "f";
    state.messageRefs = map;
    const seq = new Map([["a", 0], ["b", 1], ["c", 2], ["d", 3], ["e", 4], ["f", 5]]);
    return { state, seq };
}

test("restamp never leaves a LIVE ref in the superseded map (#4797 collision band)", () => {
    const { state, seq } = driftedState();
    const out = restampRefsToLedger(state, seq);
    // Alignment outcomes.
    assert.equal(state.messageRefs.byRaw.b, "m00002");
    assert.equal(state.messageRefs.byRaw.e, "m00005");
    assert.equal(state.messageRefs.byRaw.f, "m00006", "f takes e's vacated m00006");
    // THE invariant: no superseded key is live in the final map.
    for (const key of out.superseded.keys()) {
        assert.equal(state.messageRefs.byRef[key], undefined, `superseded key ${key} must not be live (owned by ${state.messageRefs.byRef[key]})`);
    }
    // e's old m00006 was re-occupied by f in the same pass — pruned.
    assert.equal(out.superseded.get("m00006"), undefined, "live-occupied old number pruned from superseded");
    // Genuinely vacated numbers stay (they are the translation table).
    assert.equal(out.superseded.get("m00003"), "b");
    assert.equal(out.superseded.get("m00007"), "f");
});

test("restamp migrates block startRef/endRef and deadRefs onto the new numbering (#4797 registry)", () => {
    const { state, seq } = driftedState();
    state.blocks.push({
        blockId: "b1",
        tier: 1,
        summary: "x".repeat(80),
        directMessageIds: ["e"],
        effectiveMessageIds: ["e"],
        startRef: "m00006",
        endRef: "m00006",
        active: true,
    } as never);
    state.deadRefs = ["m00003"];
    restampRefsToLedger(state, seq);
    // Block's stored span rides the migration: e's old m6 → e's new m5.
    assert.equal((state.blocks[0] as { startRef?: string }).startRef, "m00005");
    assert.equal((state.blocks[0] as { endRef?: string }).endRef, "m00005");
    // deadRefs: m00003 translates onto b's current number m00002 — but that
    // number is LIVE post-pass, so the hole claim is void and the entry is
    // dropped (#4797 collision band; empty ⇒ undefined per the #3302 rule).
    assert.equal(state.deadRefs, undefined);
});

test("restamp drops organic tombstones whose number the pass re-grants, keeps free ones (#4797 registry residual)", () => {
    const { state, seq } = driftedState();
    // m00002/m00005 are free pre-pass (organic tombstone candidates) and both
    // become seq+1 targets in this sweep (b→m2, e→m5); m00008 stays free.
    state.deadRefs = ["m00002", "m00005", "m00008"];
    restampRefsToLedger(state, seq);
    assert.deepEqual(
        state.deadRefs,
        ["m00008"],
        "re-granted tombstones dropped, genuinely-free ones kept",
    );
});

test("restamp leaves deadRefs undefined when every tombstone was re-granted (#4797 empty discipline)", () => {
    const { state, seq } = driftedState();
    state.deadRefs = ["m00002"];
    restampRefsToLedger(state, seq);
    assert.equal(state.deadRefs, undefined, "empty ⇒ undefined (#3302 discipline)");
});

test("refLedgerAligned survives the kernel's own state clones (sync node + applyCompression)", () => {
    const { state, seq } = driftedState();
    restampRefsToLedger(state, seq);
    assert.equal(state.refLedgerAligned, true);

    // syncBlocks clone path: one processTurn carrying the restamped state.
    const core = createCore();
    const config = defaultConfig(100_000, { preserveRecentMessages: 0, preserveRecentTokens: 0 });
    const messages = [msg("a"), msg("b"), msg("d"), msg("e"), msg("f")];
    const assigned = assignRefs(messages, { existing: state.messageRefs, nextIndex: 0 });
    const turn = core.processTurn({ messages, state, config, tokenCount: 10, renderTags: "none" });
    assert.equal((turn.state as { refLedgerAligned?: boolean }).refLedgerAligned, true, "flag survives processTurn's sync clone");

    // cloneState path: one applyCompression on the same state.
    const applied = core.applyCompression({
        messages,
        state: turn.state,
        config,
        ranges: [{ startRef: "m00001", endRef: "m00001", summary: "x".repeat(80) }],
    });
    if (applied.state) {
        assert.equal((applied.state as { refLedgerAligned?: boolean }).refLedgerAligned, true, "flag survives applyCompression's cloneState");
    }
});
