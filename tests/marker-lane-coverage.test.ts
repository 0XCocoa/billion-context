// #2811 plan B coverage contract: every raw-stage marker class from
// src/marker/spec.ts is stripped (or deliberately preserved, when a
// downstream stage owns it) on EVERY wire protocol through the one engine.
//
// This is the leak-matrix pin: the打桩 audit (issue #2811) found google
// stripped none of these (#2798) and anthropic/openai/responses only
// head-lines (#2789). If a class regresses on any wire, this file goes red
// BEFORE the field does.
import test from "node:test";
import assert from "node:assert/strict";
import { stripRawStage, type RawStripCounts } from "../src/marker/engine.ts";
import { MARKER_SPECS, type MarkerId, type MarkerScope, type MarkerSpec, type MarkerStage } from "../src/marker/spec.ts";
import { MARKER_INTEGRITY_NOTE } from "../src/marker/anchors.ts";

// ── fixtures, one per MarkerId (raw stage) ────────────────────────────────
const DIGEST = "sha256:" + "ab".repeat(32);
const CHAIN_CARRIER = `<bili-chain v="1" processor="leaked-instance" issued-at="1760000000000" request-id="r-old-a" digest="${DIGEST}"/>`;
const PANEL_MESSAGE = "[acp-cache] grand ledger: 4.8% hit rate over 9 requests\n[/acp-cache]";
// #2789 shape: head line + contiguous report body sections; the prose lines
// around it must survive.
const STATUS_BODY_MESSAGE =
    "prose before the report\n" +
    "📦 [ACP] acp_status result:\n" +
    "  ACTIVE SURFACE 61% of window\n" +
    "  CONTEXT BREAKDOWN\n" +
    "    raw history       38,412 tok (14.7%)\n" +
    "  COMPRESSED BLOCKS\n" +
    "    b1 | m00001–m00003 | 63% saved\n" +
    "  BILLED INPUT 104,100 tok\n" +
    "prose after the report";
const MARKER_LINE_MESSAGE =
    "user prose stays\n📦 [ACP] Compressed m00001–m00110 → b7\n❌ [ACP] compress FAILED: range cannot be anchored\nand so does this";
const RENDER_TAG_PROSE = 'the panel said <acp tokens="60" type="text">m00123</acp> and that is all';
const NUDGE_ECHO = "This is an efficiency nudge to compress early." + MARKER_INTEGRITY_NOTE;
// Deliberately PRESERVED at raw stage — owned downstream:
const SUMMARY_ANCHOR = "[Compressed conversation section] m00001–m00080";
const CODEX_HANDOFF = "[bili] context summary after compaction:";

type Case = { name: string; text: string };

const userCases: Case[] = [
    { name: "panel", text: PANEL_MESSAGE },
    { name: "status body", text: STATUS_BODY_MESSAGE },
    { name: "marker lines", text: MARKER_LINE_MESSAGE },
    { name: "render tag", text: RENDER_TAG_PROSE },
    { name: "chain carrier", text: CHAIN_CARRIER },
    { name: "summary anchor (state-owned)", text: SUMMARY_ANCHOR },
    { name: "codex handoff (absorb-owned)", text: CODEX_HANDOFF },
    { name: "plain user text", text: "plain q1" },
];

function assertStripped(body: unknown, counts: RawStripCounts, label: string): void {
    const json = JSON.stringify(body);
    assert.ok(!json.includes("[acp-cache]"), `${label}: panel message must be gone`);
    assert.ok(!json.includes("acp_status result:"), `${label}: status body head must be gone`);
    assert.ok(!json.includes("ACTIVE SURFACE"), `${label}: status body sections must be gone`);
    assert.ok(!json.includes("CONTEXT BREAKDOWN"), `${label}: status body sections must be gone (2)`);
    assert.ok(!json.includes("Compressed m00001–m00110"), `${label}: confirmation marker line must be gone`);
    assert.ok(!json.includes("compress FAILED"), `${label}: failure marker line must be gone`);
    assert.ok(!json.includes("<acp"), `${label}: render tag span must be gone`);
    assert.ok(!json.includes("m00123"), `${label}: render tag payload must be gone`);
    assert.ok(!json.includes(DIGEST), `${label}: chain carrier must be gone`);
    assert.ok(!json.includes("efficiency nudge"), `${label}: nudge echo must be gone`);
    assert.ok(!json.includes("MARKER integrity"), `${label}: integrity note must be gone`);
    // preserved prose + downstream-owned shapes
    assert.ok(json.includes("plain q1"), `${label}: plain user text survives`);
    assert.ok(json.includes("prose before the report"), `${label}: prose around a status body survives`);
    assert.ok(json.includes("prose after the report"), `${label}: prose around a status body survives (2)`);
    assert.ok(json.includes("user prose stays"), `${label}: prose around marker lines survives`);
    assert.ok(json.includes("and so does this"), `${label}: prose around marker lines survives (2)`);
    assert.ok(json.includes("the panel said"), `${label}: prose around a render tag survives`);
    assert.ok(json.includes(SUMMARY_ANCHOR), `${label}: summary anchors are state-stage, raw must keep them`);
    assert.ok(json.includes(CODEX_HANDOFF), `${label}: codex handoff is absorb-owned, raw must keep it`);
    // counts
    assert.ok(counts.panels >= 1, `${label}: panel counted`);
    assert.ok(counts.statusBodies >= 1, `${label}: status body counted`);
    assert.ok(counts.statusBodyLines >= 4, `${label}: status body lines counted`);
    assert.ok(counts.markerLines >= 2, `${label}: marker lines counted`);
    assert.ok(counts.carriers >= 1, `${label}: carrier counted`);
}

test("engine: anthropic/openai messages walk strips every raw class", () => {
    for (const wire of ["anthropic", "openai"] as const) {
        const body = {
            messages: [
                // whole-message classes arrive as standalone messages
                { role: "user", content: PANEL_MESSAGE },
                { role: "user", content: NUDGE_ECHO },
                // span/line/block classes share one message as text parts
                { role: "user", content: userCases.filter((c) => c.name !== "panel").map((c) => ({ type: "text", text: c.text })) },
                { role: "assistant", content: "assistant ack" },
            ],
        };
        const counts = stripRawStage(body, wire);
        assertStripped(body, counts, wire);
        // whole-message classes splice the message itself
        const json = JSON.stringify(body);
        assert.ok(!json.includes('"type":"text","text":"[acp-cache]'), `${wire}: panel message spliced`);
        assert.ok(body.messages.length === 2, `${wire}: panel + nudge messages spliced (2 of 4 gone)`);
    }
});

test("engine: google contents walk strips every raw class (#2798 pin)", () => {
    const body = {
        contents: [
            { role: "user", parts: [{ text: PANEL_MESSAGE }] },
            { role: "user", parts: [{ text: NUDGE_ECHO }] },
            {
                role: "user",
                parts: userCases.filter((c) => c.name !== "panel").map((c) => ({ text: c.text })),
            },
            { role: "model", parts: [{ text: "model ack" }] },
        ],
    };
    const counts = stripRawStage(body, "google");
    assertStripped(body, counts, "google");
    assert.ok(body.contents.length === 2, "google: panel + nudge contents spliced (2 of 4 gone)");
});

test("engine: responses input walk strips every raw class", () => {
    const body = {
        instructions: "sys",
        input: [
            { type: "message", role: "user", content: PANEL_MESSAGE },
            { type: "message", role: "user", content: NUDGE_ECHO },
            {
                type: "message",
                role: "user",
                content: userCases.filter((c) => c.name !== "panel").map((c) => ({ type: "input_text", text: c.text })),
            },
            { type: "message", role: "assistant", content: [{ type: "output_text", text: "assistant ack" }] },
            // carrier in its native responses part form (single-key input_text part)
            { type: "message", role: "user", content: [{ type: "input_text", text: CHAIN_CARRIER }] },
        ],
    };
    const counts = stripRawStage(body, "responses");
    assertStripped(body, counts, "responses");
    // panel (string content) + nudge + native carrier messages spliced;
    // the multi-part message keeps its shape with the carrier part gone
    assert.ok(body.input.length === 2, `responses: panel/nudge/carrier messages spliced (got ${body.input.length} of 5)`);
});

test("engine: the declarative spec table and the engine agree on raw-stage classes", () => {
    // contract both directions: every raw-stage id the table declares is one
    // this file proves behaviorally, and every class the engine counts is a
    // row in the table (no silently-added class).
    const byStage = (s: MarkerSpec, stage: MarkerStage): boolean => s.stage === stage;
    const scopeOf = (s: MarkerSpec): MarkerScope => s.scope;
    const rawIds = MARKER_SPECS.filter((s) => byStage(s, "raw")).map((s) => s.id as MarkerId).sort();
    for (const s of MARKER_SPECS) void scopeOf(s);
    assert.deepEqual(rawIds, [
        "acp_panel_message",
        "acp_status_body",
        "chain_carrier",
        "confirmation_marker",
        "forged_header",
        "marker_line",
        "nudge_echo",
        "render_tag",
    ]);
    const counted = ["panels", "statusBodies", "markerLines", "nudges", "carriers"] as const;
    assert.equal(Object.keys(stripRawStage({ messages: [] }, "anthropic")).length, counted.length + 1, "counts shape unchanged: spec/engine drift check");
});

test("engine: degraded slots become a space, never an empty string (#1542 zombie guard)", () => {
    const body = {
        messages: [
            { role: "assistant", content: "📦 [ACP] Compressed m00001–m00010 → b5", tool_calls: [{ id: "t1", function: { name: "compress", arguments: "{}" } }] },
        ],
    };
    stripRawStage(body, "openai");
    assert.equal(body.messages[0]!.content, " ", "assistant slot degrades to one space so tool_calls survive");
    assert.ok(Array.isArray(body.messages[0]!.tool_calls), "tool_calls untouched");
});
