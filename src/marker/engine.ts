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
import { MARKER_LINE, stripAcpTags } from "../loop/tag-echo-filter.js";
import type { WireProtocol } from "../util.js";
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
    const out = stripAcpTags(t);
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
    for (const rec of messages) {
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
        const text = typeof rec.content === "string" ? rec.content : undefined;
        if (text !== undefined && isNudgeEchoText(text)) {
            const i = messages.indexOf(rec);
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
// body (mutated in place). Carrier stripping stays in chain-checkpoint.ts —
// it is already per-protocol and whole-PART exact.
export function stripRawStage(parsed: unknown, wire: WireProtocol): RawStripCounts {
    const counts = emptyCounts();
    if (!isPlainRecord(parsed)) return counts;
    if (wire === "google") {
        stripGoogleContents(parsed, counts);
    } else if (wire === "responses") {
        stripResponsesInput(parsed.input, counts);
    } else {
        stripMessagesArray(parsed.messages, counts);
    }
    counts.carriers = stripEmbeddedChainCarriers(parsed, wire);
    return counts;
}
