// Raw-stage inbound marker stripping — one engine, four wire protocols
// (issue #2811 plan B). Replaces the per-prepare three-call wiring
// (stripAcpPanel* → stripAcpStatusMarkers → stripEmbeddedChainCarriers) with
// a single ordered pipeline every protocol walks the same way:
//
//   per text slot (user/assistant text):  status body → stripAcpTags
//   whole message:                        panels → nudge echoes → carriers
//
// The google walk is NEW (#2798): the old generic walk only recognized
// `content: string | part[]` and google's `content.parts` objects were
// invisible to it, so panels/status lines/nudge echoes rode the rebuild.
//
// Counts are returned per class so prepares log recognizable lines and
// tests/marker-lane-coverage.test.ts can assert every spec id fires on
// every protocol.

import { isAcpPanelText, stripAcpPanelMessages, stripAcpPanelResponsesInput } from "../acp-panel.js";
import { stripEmbeddedChainCarriers } from "../chain-checkpoint.js";
import { MARKER_LINE, stripAcpTags } from "../loop/tag-echo-filter.js";import type { WireProtocol } from "../util.js";
import { isNudgeEchoText } from "./anchors.js";
import { consumeAcpStatusBody } from "./status-body.js";

export interface RawStripCounts {
    panels: number;
    statusBodies: number;
    statusBodyLines: number;
    markerLines: number;
    nudges: number;
    carriers: number;
}

function emptyCounts(): RawStripCounts {
    return { panels: 0, statusBodies: 0, statusBodyLines: 0, markerLines: 0, nudges: 0, carriers: 0 };
}

function countMarkerLines(text: string): number {
    let n = 0;
    for (const _ of text.matchAll(MARKER_LINE)) n++;
    return n;
}

// Shared per-text-slot pipeline. Mirrors stripAcpStatusMarkers semantics:
// a slot that becomes empty degrades to a single space (an assistant message
// may still carry tool_calls whose results must not be orphaned).
function stripTextSlot(text: string, counts: RawStripCounts): string {
    let t = text;
    const body = consumeAcpStatusBody(t);
    if (body.bodies > 0) {
        t = body.text;
        counts.statusBodies += body.bodies;
        counts.statusBodyLines += body.lines;
    }
    const lines = countMarkerLines(t);
    // keepBiliArtifacts=true: the #1634 chain-tag/handoff/summary-block family
    // is model-output stripping; inbound whole-part carriers are handled
    // strictly by stripEmbeddedChainCarriers and summary anchors by the state
    // layer (#1039/#1395 user-data boundary).
    const out = stripAcpTags(t, false, undefined, true);
    if (out !== t) {
        counts.markerLines += lines;
        t = out.trim().length > 0 ? out : " ";
    }
    return t;
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === "object" && !Array.isArray(v);
}

// anthropic / openai chat `messages` walk.
function stripMessagesArray(messages: unknown, counts: RawStripCounts): void {
    if (!Array.isArray(messages)) return;
    counts.panels += stripAcpPanelMessages(messages);
    // reverse index: nudge splices remove the current element, and a forward
    // for..of would silently skip the next message after each splice
    for (let i = messages.length - 1; i >= 0; i--) {
        const rec = messages[i];
        if (!isPlainRecord(rec)) continue;
        const role = rec.role;
        if (role !== "user" && role !== "assistant") continue;
        if (typeof rec.content === "string") {
            rec.content = stripTextSlot(rec.content, counts);
        } else if (Array.isArray(rec.content)) {
            for (const part of rec.content) {
                if (!isPlainRecord(part)) continue;
                if (typeof part.text === "string") part.text = stripTextSlot(part.text, counts);
            }
        }
        // nudge echoes: whole user message (exact tail match); an assistant
        // echo degrades to a space so tool_calls survive
        if (typeof rec.content === "string" && isNudgeEchoText(rec.content)) {
            if (role === "user") {
                messages.splice(i, 1);
                counts.nudges++;
            } else {
                rec.content = " ";
            }
        }
    }
}

// google `contents` walk (#2798 fix): text parts live at content.parts[].text.
function stripGoogleContents(parsed: unknown, counts: RawStripCounts): void {
    if (!isPlainRecord(parsed) || !Array.isArray(parsed.contents)) return;
    const contents = parsed.contents;
    for (let i = contents.length - 1; i >= 0; i--) {
        const c = contents[i];
        if (!isPlainRecord(c)) continue;
        const role = typeof c.role === "string" ? c.role : "user";
        if (role !== "user" && role !== "model") continue;
        const parts = c.parts;
        if (!Array.isArray(parts)) continue;
        for (const p of parts) {
            if (isPlainRecord(p) && typeof p.text === "string") p.text = stripTextSlot(p.text, counts);
        }
        // whole-content removal only under carrier strictness: every part is
        // a single-key {text} and the joined text matches a panel / nudge.
        const allPlain = parts.every(
            (p) => isPlainRecord(p) && Object.keys(p).length === 1 && typeof p.text === "string",
        );
        if (allPlain) {
            const joined = parts.map((p) => (p as Record<string, unknown>).text as string).join("");
            if (isAcpPanelText(joined) || isNudgeEchoText(joined)) {
                contents.splice(i, 1);
                counts.panels += isAcpPanelText(joined) ? 1 : 0;
                counts.nudges += isNudgeEchoText(joined) && !isAcpPanelText(joined) ? 1 : 0;
            }
        }
    }
}

// Responses `input` walk: message items (plus the type-less omp wire form).
function stripResponsesInput(input: unknown, counts: RawStripCounts): void {
    if (!Array.isArray(input)) return;
    counts.panels += stripAcpPanelResponsesInput(input);
    for (let i = input.length - 1; i >= 0; i--) {
        const rec = input[i];
        if (!isPlainRecord(rec)) continue;
        const type = rec.type;
        if (type !== "message" && type !== undefined) continue;
        const role = typeof rec.role === "string" ? rec.role : "";
        if (role !== "user" && role !== "assistant") continue;
        if (typeof rec.content === "string") {
            rec.content = stripTextSlot(rec.content, counts);
            if (role === "user" && isNudgeEchoText(rec.content as string)) {
                input.splice(i, 1);
                counts.nudges++;
            }
        } else if (Array.isArray(rec.content)) {
            for (const part of rec.content) {
                if (isPlainRecord(part) && typeof part.text === "string") part.text = stripTextSlot(part.text, counts);
            }
        }
    }
}

// One raw stage for every wire protocol. `parsed` is the decoded request
// body (mutated in place). Carrier stripping runs FIRST and stays in
// chain-checkpoint.ts — it is whole-PART exact per protocol, and running it
// after the text-slot pass would hide its strict semantics behind the
// lenient tag stripper (whitespace zombies instead of message splices,
// #1542's log line starved).
export function stripRawStage(parsed: unknown, wire: WireProtocol): RawStripCounts {
    const counts = emptyCounts();
    if (!isPlainRecord(parsed)) return counts;
    counts.carriers = stripEmbeddedChainCarriers(parsed, wire);
    if (wire === "google") {
        stripGoogleContents(parsed, counts);
    } else if (wire === "responses") {
        stripResponsesInput(parsed.input, counts);
    } else {
        stripMessagesArray(parsed.messages, counts);
    }
    return counts;
}

// Uniform prepare-side logging for the raw stage. Phrases stay compatible
// with the per-prepare lines this engine replaced (#359 / #1029 / #1542),
// plus the two classes that are new at this layer (#2789 / nudge echoes).
export function logRawStripCounts(
    counts: RawStripCounts,
    log: (level: "info" | "warn", msg: string) => void,
    sessionId: string,
): void {
    if (counts.panels > 0) {
        log("info", `[${sessionId}] stripped ${counts.panels} ACP panel message(s) before projection (UI-only, issue #359)`);
    }
    if (counts.markerLines > 0) {
        log("info", `[${sessionId}] stripped ${counts.markerLines} ACP status marker line(s) from incoming history (ephemeral proxy status, issue #1029)`);
    }
    if (counts.statusBodies > 0) {
        log("info", `[${sessionId}] stripped ${counts.statusBodies} acp_status report bod${counts.statusBodies === 1 ? "y" : "ies"} (${counts.statusBodyLines} line(s)) from incoming history (orphaned report body, issue #2789)`);
    }
    if (counts.nudges > 0) {
        log("info", `[${sessionId}] stripped ${counts.nudges} nudge echo message(s) from incoming history (persisted proxy nudge)`);
    }
    if (counts.carriers > 0) {
        log("info", `[${sessionId}] stripped ${counts.carriers} embedded chain checkpoint(s) from incoming history (leaked egress control data, issue #1542)`);
    }
}
