// #3733: bili-authored dsh client compaction.
//
// The #1729 guard refuses dsh's native compaction summarize calls. Post-#3644
// (snapshot doctrine) a landed client checkpoint is benign for the server
// substrate — but a NATIVE checkpoint is still a foreign summary we can only
// recognize fuzzily, and it may not match what the upstream actually sees.
// Authored compaction answers the SAME call locally (zero egress, autoModeForge
// discipline): the response we hand back is OUR folded snapshot, carrying an
// identity header line. dsh writes it into its history as the checkpoint, so
// the client file shrinks (fixes #3723's unbounded growth) while the content
// stays exactly what the model already has upstream.
//
// This file pins the contract BEFORE the implementation (打桩): unit shapes
// (header / forge bodies / detector) and the end-to-end lane (interception,
// zero upstream contact, ledger marks, knob-off fallthrough to refusal,
// no-block fallthrough, stream honoring, allow-precedence, and the landing
// recognition on the post-compaction replay).
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions, _resetSessionsForTest } from "../src/session.ts";
import { DSH_COMPACTION_INSTRUCTION_PREFIX, DSH_CHECKPOINT_OPEN_TAG, DSH_CHECKPOINT_PREAMBLE_PREFIX } from "../src/server/dsh-compaction-guard.ts";
import {
    BILI_SNAPSHOT_TAG_PREFIX,
    buildDshCompactionForgeBody,
    carriesBiliSnapshotCheckpoint,
    renderDshAuthoredCheckpoint,
} from "../src/server/dsh-authored-compaction.ts";
import { rmrf } from "./tmp-rm.ts";

// ---------------------------------------------------------------------------
// Unit: checkpoint text.

function fakeBlock(blockId: string, summary: string, topic?: string): { blockId: string; summary: string; topic?: string; active: true } {
    return { blockId, summary, topic, active: true };
}

test("unit: checkpoint = identity header + kernel-rendered block summaries", () => {
    const session = {
        id: "s-3733",
        state: {
            messageRefs: { byRaw: Object.fromEntries(Array.from({ length: 42 }, (_, i) => [`m${i}`, {}])) },
            blocks: [fakeBlock("b1", "setup folded", "setup"), fakeBlock("b2", "later work folded")],
        },
    };
    const text = renderDshAuthoredCheckpoint(session as never);
    const lines = text.split("\n");
    assert.ok(lines[0].startsWith(BILI_SNAPSHOT_TAG_PREFIX), "first line is the identity header");
    assert.match(lines[0], /conv="s-3733"/);
    assert.match(lines[0], /seq="42"/);
    assert.match(lines[0], /blocks="b1\+b2"/);
    assert.ok(text.includes("[Compressed conversation section] — setup"), "kernel render format (topic)");
    assert.ok(text.includes("setup folded"));
    assert.ok(text.includes("[Compressed conversation section]"), "kernel render format (no topic)");
    assert.ok(text.includes("later work folded"));
});

test("unit: inactive blocks are skipped; empty active set renders header only", () => {
    const session = {
        id: "s-none",
        state: { messageRefs: { byRaw: {} }, blocks: [{ blockId: "b1", summary: "SECRET-INACTIVE", active: false }] },
    };
    const text = renderDshAuthoredCheckpoint(session as never);
    assert.ok(text.startsWith(BILI_SNAPSHOT_TAG_PREFIX));
    assert.ok(!text.includes("SECRET-INACTIVE"), "inactive block content absent");
});

// ---------------------------------------------------------------------------
// Unit: forge bodies (all three dsh wires, stream and JSON).

const SAMPLE = `<bili-snapshot v1 conv="s" seq="1" blocks="b1" />
[Compressed conversation section]
summary body`;

function parseSseFrames(body: string): { event?: string; data: unknown }[] {
    const frames: { event?: string; data: unknown }[] = [];
    for (const block of body.trim().split("\n\n")) {
        let event: string | undefined;
        let data = "";
        for (const line of block.split("\n")) {
            if (line.startsWith("event: ")) event = line.slice(7).trim();
            else if (line.startsWith("data: ")) data += line.slice(6);
        }
        if (data === "[DONE]") frames.push({ event, data: "[DONE]" });
        else if (data !== "") frames.push({ event, data: JSON.parse(data) });
    }
    return frames;
}


// Non-null wrapper: these unit cases assert the happy path; the null path is
// pinned separately (unknown protocol).
function buildDshCompactionForgeBodyOrFail(...args: Parameters<typeof buildDshCompactionForgeBody>) {
    const out = buildDshCompactionForgeBody(...args);
    if (out === null) throw new Error("forge body unexpectedly null");
    return out;
}

test("unit: openai JSON forge body", () => {
    const { body, contentType } = buildDshCompactionForgeBodyOrFail("openai", SAMPLE, { inputTokens: 100, outputTokens: 10 }, false);
    assert.equal(contentType, "application/json");
    const j = JSON.parse(body);
    assert.equal(j.choices[0].message.role, "assistant");
    assert.equal(j.choices[0].message.content, SAMPLE);
    assert.equal(j.choices[0].finish_reason, "stop");
    assert.ok(j.usage && typeof j.usage.total_tokens === "number");
});

test("unit: openai SSE forge body", () => {
    const { body, contentType } = buildDshCompactionForgeBodyOrFail("openai", SAMPLE, { inputTokens: 100, outputTokens: 10 }, true);
    assert.equal(contentType, "text/event-stream");
    const frames = parseSseFrames(body);
    const last = frames[frames.length - 1];
    assert.equal(last.data, "[DONE]", "terminal [DONE]");
    const deltas = frames.filter((f) => (f.data as { choices?: { delta?: { content?: unknown } }[] })?.choices?.[0]?.delta?.content !== undefined);
    assert.ok(deltas.length >= 1, "at least one content delta");
    const joined = deltas.map((f) => (f.data as { choices: { delta: { content: string } }[] }).choices[0].delta.content).join("");
    assert.ok(joined.includes(BILI_SNAPSHOT_TAG_PREFIX), "checkpoint text delivered");
    const finish = frames.find((f) => (f.data as { choices?: { finish_reason?: string }[] })?.choices?.[0]?.finish_reason === "stop");
    assert.ok(finish, "finish_reason stop frame");
});

test("unit: anthropic JSON forge body", () => {
    const { body, contentType } = buildDshCompactionForgeBodyOrFail("anthropic", SAMPLE, { inputTokens: 100, outputTokens: 10 }, false);
    assert.equal(contentType, "application/json");
    const j = JSON.parse(body);
    assert.equal(j.type, "message");
    assert.equal(j.role, "assistant");
    assert.equal(j.content[0].type, "text");
    assert.equal(j.content[0].text, SAMPLE);
    assert.equal(j.stop_reason, "end_turn");
});

test("unit: anthropic SSE forge body (event order)", () => {
    const { body, contentType } = buildDshCompactionForgeBodyOrFail("anthropic", SAMPLE, { inputTokens: 100, outputTokens: 10 }, true);
    assert.equal(contentType, "text/event-stream");
    const events = parseSseFrames(body).map((f) => (f.data as { type?: string }).type);
    assert.equal(events[0], "message_start");
    assert.ok(events.includes("content_block_start"));
    assert.ok(events.includes("content_block_delta"));
    assert.ok(events.includes("content_block_stop"));
    assert.ok(events.includes("message_delta"));
    assert.equal(events[events.length - 1], "message_stop");
    const textDelta = parseSseFrames(body).find((f) => (f.data as { type?: string }).type === "content_block_delta");
    assert.equal((textDelta!.data as { delta: { text?: string } }).delta.text, SAMPLE);
});

test("unit: responses wire delegates to the codex prompt-forge shape", () => {
    for (const stream of [false, true]) {
        const { body, contentType } = buildDshCompactionForgeBodyOrFail("responses", SAMPLE, { inputTokens: 100, outputTokens: 10 }, stream);
        if (stream) {
            assert.equal(contentType, "text/event-stream");
            const frames = parseSseFrames(body);
            const types = frames.map((f) => (f.data as { type?: string }).type).filter(Boolean);
            assert.ok(types.includes("response.created"));
            assert.ok(types.includes("response.completed"));
            const delta = frames.find((f) => (f.data as { type?: string }).type === "response.output_text.delta") as { data: { delta: string } } | undefined;
            assert.equal(delta?.data.delta, SAMPLE);
        } else {
            assert.equal(contentType, "application/json");
            const j = JSON.parse(body);
            const item = j.output.find((o: { type?: string }) => o.type === "message");
            assert.equal(item.role, "assistant");
            assert.equal(item.content[0].text, SAMPLE);
        }
    }
});

test("unit: unknown protocol returns null (caller falls through to refusal)", () => {
    assert.equal(buildDshCompactionForgeBody("google" as never, SAMPLE, { inputTokens: 1, outputTokens: 1 }, true), null);
});

// ---------------------------------------------------------------------------
// Unit: landing recognition (tag detector, #2621 carrier discipline).

test("unit: carriesBiliSnapshotCheckpoint — carrier + novelty gates", () => {
    const tagged = `${DSH_CHECKPOINT_PREAMBLE_PREFIX}: something\n\n${DSH_CHECKPOINT_OPEN_TAG}\n${SAMPLE}\n</compacted-summary>`;
    assert.equal(carriesBiliSnapshotCheckpoint([{ id: "n1", role: "user", contentType: "text", text: tagged }]), true, "fresh user plain-text checkpoint matches");
    assert.equal(carriesBiliSnapshotCheckpoint([{ id: "n2", role: "assistant", text: tagged }]), false, "assistant carrier rejected");
    assert.equal(carriesBiliSnapshotCheckpoint([{ id: "n3", role: "user", contentType: "tool-result", text: tagged }]), false, "tool-result carrier rejected");
    assert.equal(carriesBiliSnapshotCheckpoint([{ id: "n4", role: "user", text: tagged }], new Set(["n4"])), false, "old id (historical quote) rejected under novelty gate");
    assert.equal(carriesBiliSnapshotCheckpoint([{ id: "n5", role: "user", text: "plain question" }]), false, "no tag no match");
});

// ---------------------------------------------------------------------------
// E2E: real proxy + mock upstream on the openai wire (dsh's primary lane).

const SUMMARY = "MAIN-SUMMARY-SETUP-CONTEXT-FOLDED-BY-COMPRESSION-LONG-ENOUGH-FOR-KERNEL-MIN-LENGTH-CHECK";

function sse(obj: unknown): string {
    return `data: ${JSON.stringify(obj)}\n\n`;
}

// 24 messages × ~1.5k chars (~375 tokens each): total ~9k tokens stays under
// the 15k window (no preflight); the default protection zone (preserveRecent
// 3 + 5000-token walk ≈ 14 messages) leaves the first ~10 compressible, so the
// m00001..m00008 range lands intact — 8 covered ids = DSH_LOCAL_COMPACTION_MIN_MISSING,
// enough for the #2432/#3733 landing gate to see a real region replacement.
function conversation(): { role: string; content: string }[] {
    const out: { role: string; content: string }[] = [];
    for (let i = 0; i < 24; i++) {
        out.push({ role: i % 2 === 0 ? "user" : "assistant", content: `Message ${i} of the working session. ` + `WORK_${i}_content_`.repeat(88) });
    }
    return out;
}

type Harness = { proxy: http.Server; upstream: http.Server; bodies: string[]; url: string; sessionOf: (label: string) => { meta: { label: string }; state: { blocks: { id: string; active: boolean }[] }; metadata: Record<string, unknown> } | undefined };

async function withHarness(fn: (h: Harness) => Promise<void>, optsOverride: Partial<ProxyOptions> = {}): Promise<void> {
    const bodies: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            bodies.push(Buffer.concat(chunks).toString("utf8"));
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            if (bodies.length === 1) {
                // First turn: the model compresses the oldest pair → active block.
                const args = JSON.stringify({ content: [{ startId: "m00001", endId: "m00008", topic: "setup", summary: SUMMARY }] });
                res.write(sse({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_p", type: "function", function: { name: "compress", arguments: args } }] } }] }));
                res.write(sse({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }));
                res.write(sse({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "done compressing" } }] }));
            }
            res.write(sse({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest();
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: 15_000 } } } },
        modelContextLimit: 15_000,
        kernelConfig: defaultConfig(15_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        passthroughSource: null,
        autoUpdate: false,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: true,
        releaseNotesCheck: true,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        mitm: { enabled: false, domains: [] },
        ...optsOverride,
    } as unknown as ProxyOptions);
    await once(proxy, "listening");
    const port = (proxy.address() as { port: number }).port;
    const h: Harness = {
        proxy,
        upstream,
        bodies,
        url: `http://127.0.0.1:${port}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`,
        sessionOf: (label) => listSessions().find((x) => x.meta.label === label) as never,
    };
    try {
        await fn(h);
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
        delete process.env.BILI_DSH_AUTHORED_COMPACTION;
        delete process.env.BILI_ALLOW_DSH_COMPACTION;
    }
}

async function turn(h: Harness, label: string, messages: unknown[], extraHeaders: Record<string, string> = {}, stream = true): Promise<{ status: number; body: string; contentType: string }> {
    const r = await fetch(h.url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": label, ...extraHeaders },
        body: JSON.stringify({ model: "gpt-test", messages, stream }),
    });
    return { status: r.status ?? 0, body: await r.text(), contentType: r.headers.get("content-type") ?? "" };
}

/** One normal turn that leaves an active block behind. */
async function armBlock(h: Harness, label: string): Promise<void> {
    const r = await turn(h, label, conversation());
    assert.equal(r.status, 200, r.body);
    const s = h.sessionOf(label);
    assert.ok(s, "session exists");
    assert.ok(s!.state.blocks.some((b) => b.active), "setup created an active block");
}

test("e2e: authored compaction answers locally — zero egress, tagged checkpoint, ledger marks", async () => {
    await withHarness(async (h) => {
        await armBlock(h, "s-auth");
        const before = h.bodies.length;
        process.env.BILI_DSH_AUTHORED_COMPACTION = "1";
        const r = await turn(h, "s-auth", [
            { role: "system", content: "sys" },
            { role: "user", content: "x".repeat(600_000) },
            { role: "user", content: `${DSH_COMPACTION_INSTRUCTION_PREFIX} Condense the conversation above.` },
        ]);
        assert.equal(r.status, 200, r.body);
        assert.match(r.contentType, /text\/event-stream/);
        assert.ok(r.body.includes(BILI_SNAPSHOT_TAG_PREFIX), "identity header in the forged stream");
        assert.ok(r.body.includes(SUMMARY), "block summary in the forged stream");
        assert.equal(h.bodies.length, before, "upstream never contacted (zero egress)");
        const s = h.sessionOf("s-auth")!;
        assert.equal(s.metadata["dshAuthoredCompactions"], 1, "authored counter");
        assert.ok(typeof s.metadata["dshCompactionRefusedBytes"] === "number", "raw ledger high-water still marked");
        assert.equal(s.metadata["dshCompactionRefusals"], undefined, "not counted as a refusal");
    });
});

test("e2e: stream:false honored — JSON body with the checkpoint text", async () => {
    await withHarness(async (h) => {
        await armBlock(h, "s-json");
        process.env.BILI_DSH_AUTHORED_COMPACTION = "1";
        const r = await turn(h, "s-json", [
            { role: "user", content: `${DSH_COMPACTION_INSTRUCTION_PREFIX} Condense.` },
        ], {}, false);
        assert.equal(r.status, 200, r.body);
        assert.match(r.contentType, /application\/json/);
        const j = JSON.parse(r.body);
        assert.ok(j.choices[0].message.content.includes(BILI_SNAPSHOT_TAG_PREFIX));
    });
});

test("e2e: knob off → the #1729 refusal still stands (status quo pinned)", async () => {
    await withHarness(async (h) => {
        await armBlock(h, "s-off");
        delete process.env.BILI_DSH_AUTHORED_COMPACTION;
        const r = await turn(h, "s-off", [
            { role: "user", content: `${DSH_COMPACTION_INSTRUCTION_PREFIX} Condense.` },
        ]);
        assert.equal(r.status, 422, r.body);
        assert.equal(JSON.parse(r.body).error.code, "dsh_compaction_refused");
        assert.equal(h.bodies.filter((b) => b.includes(DSH_COMPACTION_INSTRUCTION_PREFIX)).length, 0, "never forwarded");
    });
});

test("e2e: no active blocks → authored mode falls through to refusal", async () => {
    await withHarness(async (h) => {
        process.env.BILI_DSH_AUTHORED_COMPACTION = "1";
        const r = await turn(h, "s-cold", [
            { role: "user", content: `${DSH_COMPACTION_INSTRUCTION_PREFIX} Condense.` },
        ]);
        assert.equal(r.status, 422, "nothing to checkpoint — refuse like today");
    });
});

test("e2e: explicit allowDshCompaction wins over authored mode (user asked for native)", async () => {
    const allowNative: (h: Harness) => Promise<void> = async (h) => {
        await armBlock(h, "s-allow");
        process.env.BILI_DSH_AUTHORED_COMPACTION = "1";
        const r = await turn(h, "s-allow", [
            { role: "user", content: `${DSH_COMPACTION_INSTRUCTION_PREFIX} Condense.` },
        ]);
        assert.equal(r.status, 200, r.body);
        assert.ok(h.bodies.some((b) => b.includes(DSH_COMPACTION_INSTRUCTION_PREFIX)), "forwarded natively");
        const s = h.sessionOf("s-allow")!;
        assert.equal(s.metadata["dshAuthoredCompactions"], undefined, "not authored");
    };
    await withHarness(allowNative, { allowDshCompaction: true } as Partial<ProxyOptions>);
});

test("e2e: landed checkpoint is recognized on replay — rebase + authored-landed mark", async () => {
    await withHarness(async (h) => {
        await armBlock(h, "s-land");
        process.env.BILI_DSH_AUTHORED_COMPACTION = "1";
        const forged = await turn(h, "s-land", [
            { role: "user", content: `${DSH_COMPACTION_INSTRUCTION_PREFIX} Condense.` },
        ]);
        assert.equal(forged.status, 200);
        // Extract the checkpoint text the way dsh would record it (preamble +
        // tags around our payload).
        const frames = forged.body.split("\n\n").filter((b) => b.startsWith("data: ") && !b.includes("[DONE]"));
        const deltas = frames.map((f) => { try { return JSON.parse(f.slice(6)); } catch { return null; } })
            .map((j) => j?.choices?.[0]?.delta?.content)
            .filter((c: unknown): c is string => typeof c === "string");
        const payload = deltas.join("");
        assert.ok(payload.includes(BILI_SNAPSHOT_TAG_PREFIX));
        const checkpointText = `${DSH_CHECKPOINT_PREAMBLE_PREFIX}:\n\n${DSH_CHECKPOINT_OPEN_TAG}\n${payload}\n\x3c/compacted-summary\x3e`;
        // Next turn: dsh replays [checkpoint, retained tail] against the same session.
        // #2432/#3733 recognition is dsh-lane scoped: the replay carries the
        // dsh plugin identity so laneDecisions.profile.compactsClientSide is
        // true (the guard + forge above are marker-based and lane-agnostic).
        const r = await turn(h, "s-land", [
            { role: "user", content: checkpointText },
            { role: "assistant", content: "ack" },
            { role: "user", content: "continue the work" },
        ], { "x-bili-plugin": "dsh" });
        assert.equal(r.status, 200, r.body);
        const s = h.sessionOf("s-land")!;
        assert.equal(s.metadata["dshAuthoredCheckpointLanded"], true, "authored landing recognized");
    });
});
