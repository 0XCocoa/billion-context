// #3016: the dsh native-compaction guard (#1729/#2722/#2843) refused EVERY dsh
// compaction envelope — on both the unattributed passthrough lane
// (x-bili-passthrough, #1117/#2709) and the attributed pipeline lane — WITHOUT
// ever checking whether bili had a compression substrate to protect. When bili's
// own nudge/decision channel dies and never builds substrate (state.blocks=0 —
// the #3004 deadlock), refusing destroys nothing: it only kills the LAST
// backstop (dsh's own compaction) exactly when it is the only shrink left,
// pinning context at the wall until the hard limit. Incident: session df251671,
// 765K/984K, blocks=0 → 422 dsh_compaction_refused on the unattributed lane.
//
// Fix: gate the refusal on substrate presence.
//   - pipeline lane: the target IS the resolved session → read its OWN blocks;
//     blocks==0 → relay verbatim so dsh's checkpoint lands.
//   - passthrough lane: NO resolved session exists there (the client stamps only
//     x-bili-passthrough, #1117/#2709), so the target's own blocks are unknowable
//     → conservative-sound gate: refuse only while ANY live session holds
//     substrate; when none does, stand down and relay. Never allows when the
//     target could have substrate.
//
// These tests pin BOTH gates in BOTH substrate states. allowDshCompaction
// (#2028) short-circuits before either gate (covered by issue2028 / issue2709).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { DSH_COMPACTION_INSTRUCTION_PREFIX } from "../src/server/dsh-compaction-guard.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { getSession, _resetSessionsForTest } from "../src/session.ts";

const INSTRUCTION = DSH_COMPACTION_INSTRUCTION_PREFIX +
    " Summarize the conversation so far, retaining key decisions and open tasks.";

/** rc.2 shape: full-region replay with the instruction as the FINAL user message. */
function compactionBody(): string {
    const filler = Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `earlier turn ${i} of the shadowed region` }));
    return JSON.stringify({ model: "gpt-test", messages: [...filler, { role: "user", content: INSTRUCTION }] });
}

function seedSubstrate(id: string): void {
    getSession(id).state.blocks.push({
        blockId: "b0", runId: "r0", tier: 1, topic: "t", summary: "s",
        directMessageIds: ["m1"], effectiveMessageIds: ["m1"], directBlockIds: [],
        compressedTokens: 100, createdAt: Date.now(), survivedCount: 1, generation: "young", active: true,
    });
}

async function startMock(): Promise<{ port: number; captured: string[]; close(): Promise<void> }> {
    return new Promise((resolve, reject) => {
        const captured: string[] = [];
        const upstream = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () => {
                captured.push(Buffer.concat(chunks).toString("utf8"));
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    id: "chatcmpl_3016", object: "chat.completion", created: 1, model: "gpt-test",
                    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                    usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
                }));
            });
        });
        upstream.once("error", reject);
        upstream.listen(0, "127.0.0.1");
        once(upstream, "listening").then(() => resolve({
            port: (upstream.address() as AddressInfo).port,
            captured,
            async close() { upstream.close(); await once(upstream, "close"); },
        })).catch(reject);
    });
}

async function startProxy(opts: ProxyOptions): Promise<{ port: number; close(): Promise<void> }> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetSessionsForTest();
    const proxy = await startServer(opts);
    await once(proxy, "listening");
    return {
        port: (proxy.address() as AddressInfo).port,
        async close() { proxy.close(); await once(proxy, "close"); },
    };
}

/** Unattributed-lane routing (#1117): explicit /bili/<origin>/... target. */
function passthroughOpts(mockPort: number): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${mockPort}`]: { models: { "gpt-test": { context: 400_000 } } } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        promptCache: { routing: "auto" },
        compress: { injectTool: false, injectNudge: false },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions;
}

/** Attributed-lane routing: default upstream + x-acp-session resolution. */
function pipelineOpts(mockPort: number): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: `http://127.0.0.1:${mockPort}`,
        routes: {},
        proxy: "",
        proxyMode: "direct",
        proxySource: "direct",
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions;
}

test("#3016: passthrough compaction RELAYS verbatim when no live session has substrate (core fix)", async () => {
    const mock = await startMock();
    const h = await startProxy(passthroughOpts(mock.port));
    try {
        // Clean map (harness reset) — no compression substrate anywhere. The
        // unattributed lane must let dsh's checkpoint land instead of refusing.
        const body = compactionBody();
        const resp = await fetch(`http://127.0.0.1:${h.port}/bili/http://127.0.0.1:${mock.port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-passthrough": "1" },
            body,
        });
        assert.equal(resp.status, 200, `expected relay (got ${resp.status}: ${await resp.clone().text()})`);
        assert.equal(mock.captured.length, 1, "relayed to upstream — dsh's checkpoint can land");
        assert.equal(mock.captured[0], body, "byte-exact verbatim relay");
    } finally {
        await h.close();
        await mock.close();
    };
});

test("#3016: passthrough compaction REFUSES while any live session holds substrate (guard holds)", async () => {
    const mock = await startMock();
    const h = await startProxy(passthroughOpts(mock.port));
    try {
        // A DIFFERENT live session holds substrate → the conservative-sound gate
        // cannot prove the (unknown) target is empty, so it still refuses.
        seedSubstrate("some-other-live-session");
        const resp = await fetch(`http://127.0.0.1:${h.port}/bili/http://127.0.0.1:${mock.port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-passthrough": "1" },
            body: compactionBody(),
        });
        assert.equal(resp.status, 422);
        assert.match(await resp.text(), /dsh_compaction_refused/);
        assert.equal(mock.captured.length, 0, "refused — nothing lands");
    } finally {
        await h.close();
        await mock.close();
    };
});

test("#3016: pipeline compaction RELAYS when the resolved session has no substrate", async () => {
    const mock = await startMock();
    const h = await startProxy(pipelineOpts(mock.port));
    try {
        // Do NOT pre-seed s-3016-p → the handler creates it fresh (blocks=0),
        // the exact #3004-deadlock shape: huge context, zero substrate.
        const body = compactionBody();
        const resp = await fetch(`http://127.0.0.1:${h.port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "s-3016-p" },
            body,
        });
        assert.equal(resp.status, 200, `expected relay (got ${resp.status}: ${await resp.clone().text()})`);
        assert.equal(mock.captured.length, 1, "relayed — dsh's checkpoint lands");
    } finally {
        await h.close();
        await mock.close();
    };
});

test("#3016: pipeline compaction REFUSES when the resolved session has substrate (+#2490 bytes recorded)", async () => {
    const mock = await startMock();
    const h = await startProxy(pipelineOpts(mock.port));
    try {
        seedSubstrate("s-3016-q");
        const resp = await fetch(`http://127.0.0.1:${h.port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "s-3016-q" },
            body: compactionBody(),
        });
        assert.equal(resp.status, 422);
        assert.match(await resp.text(), /dsh_compaction_refused/);
        assert.equal(mock.captured.length, 0, "refused — nothing lands");
        const s = getSession("s-3016-q");
        assert.ok(s, "session exists");
        assert.equal(s.metadata.dshCompactionRefused, true, "#1835 flag still set");
        assert.ok(typeof s.metadata["dshCompactionRefusedBytes"] === "number" && (s.metadata["dshCompactionRefusedBytes"] as number) > 0, "#2490 refused-bytes high-water mark recorded");
    } finally {
        await h.close();
        await mock.close();
    };
});
