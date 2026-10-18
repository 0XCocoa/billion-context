import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig, defaultCountTokens } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { getSession } from "../src/session.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

// #3645: the raw-range futility gate compared an UNCALIBRATED foldable mass against
// a CALIBRATED payload deficit. Once a matching-origin k̂>1 is set (#1933 F1), the
// deficit is inflated ×k while kernel range.tokens stay on the raw scale, so a fold
// that would fit the window was declared futile and skipped → non-retryable 502
// (incident: k̂=2.13, raw pool 163K vs calibrated deficit 313K → skip, then 502).
// The gate must compare like with like: calibrate the fold mass onto the deficit's
// scale before judging. Identity for k̂=1 / absent / mismatched-origin (#1841 byte-stable).
//
// All token math is ASCII filler → ceil(len/4), matching the host estimator.
// Sizing (WINDOW=30K, slack 1.2, k̂=2): bash pairs are hard-protected (never
// foldable) and set the calibrated deficit D = 2·payload − 30K strictly between
// pool×1.2 (old raw gate → futile, the bug) and pool×2×1.2 (new calibrated gate →
// viable), while the protected bulk keeps the post-fold payload under the window so
// the recovered walk forwards.

const WINDOW = 30_000;
const K = 2; // seeded calibration factor — deliberately >1 to expose the unit mismatch
const SUMMARY_TEXT =
    "PREFLIGHT SUMMARY: this segment is a load-growth fixture whose every marker is derivable from its turn index.";

type Call = { summary: boolean; raw: string };
let CALLS: Call[] = [];
let summaryResponder: (raw: string) => { content: string; finishReason: string };

function chatSse(text: string, finishReason: string): string {
    const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
        `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    return chunk({ role: "assistant" }, null) + chunk({ content: text }, null) + chunk({}, finishReason) + "data: [DONE]\n\n";
}

function mockUpstream(): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            const isSummary = /TASK: The conversation segment below/.test(raw);
            CALLS.push({ summary: isSummary, raw });
            if (!isSummary) {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(chatSse("forwarded answer", "stop"));
                return;
            }
            const r = summaryResponder(raw);
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(chatSse(r.content, r.finishReason));
        });
    });
}

function proxyOptions(upstreamPort: number, recentTokens: number): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: WINDOW } } } } as ProxyOptions["routes"],
        modelContextLimit: WINDOW,
        kernelConfig: defaultConfig(WINDOW, {
            preserveRecentMessages: 2,
            preserveRecentTokens: recentTokens,
            protectedTools: ["bash"],
            compress: { minCompressRange: 1000, maxSummaryLength: 20000, minSummaryLength: 50 },
        }),
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

function plain(role: string, text: string): Record<string, unknown> {
    return { role, content: text };
}

function bashPair(id: number, resultRepeat: number): Record<string, unknown>[] {
    return [
        { role: "assistant", content: null, tool_calls: [{ id: `call_${id}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "echo hi" }) } }] },
        { role: "tool", tool_call_id: `call_${id}`, content: `BASH_RESULT_${id}_payload_`.repeat(resultRepeat) },
    ];
}

async function boot(recentTokens = 2000): Promise<{ proxyPort: number; upstreamPort: number; cleanup: () => Promise<void> }> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const upstream = mockUpstream();
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startServer(proxyOptions(upstreamPort, recentTokens));
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        proxyPort,
        upstreamPort,
        cleanup: async () => {
            proxy.close();
            proxy.closeIdleConnections?.();
            await once(proxy, "close");
            upstream.close();
            upstream.closeIdleConnections?.();
            await once(upstream, "close");
        },
    };
}

function post(p: { proxyPort: number; upstreamPort: number }, session: string, messages: Record<string, unknown>[]): Promise<Response> {
    return fetch(`http://127.0.0.1:${p.proxyPort}/bili/http://127.0.0.1:${p.upstreamPort}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": session },
        body: JSON.stringify({ model: "gpt-test", stream: true, messages }),
    });
}

// Stamp a matching-origin calibration factor onto a fresh session (the incident had
// known usage evidence + persisted k̂). Pre-creating the session lets us set stats
// before the over-window request reaches preflight. No baseline is seeded: a
// named (non-anonymous) session is baseline-known from its first request (#1841).
function seedCalibratedSession(sessionId: string, upstreamPort: number): void {
    const s = getSession(sessionId);
    s.stats.calibratedEstimate = K;
    s.stats.calibratedEstimateOrigin = `http://127.0.0.1:${upstreamPort}`; // == currentOrigin → ×K applies
}

test("#3645: matching-origin k̂>1 no longer skips a raw fold that fits the window", async () => {
    CALLS = [];
    summaryResponder = () => ({ content: SUMMARY_TEXT, finishReason: "stop" });
    const p = await boot(9_000);
    try {
        // Plain-text only (tool turns couple into the protected-zone carve and shrink the
        // exposed pool). OLD block = foldable pool P; RECENT block = last 2 runs, protected
        // by preserveRecentTokens=9000, and kept under the calibrated half-window (K·floor<30K)
        // so folding genuinely closes the gap.
        const oldA = "OLD_A ".repeat(3334);
        const oldB = "OLD_B ".repeat(3334);
        const oldC = "OLD_C ".repeat(3334);
        const oldD = "OLD_D ".repeat(3334);
        const recA = "REC_A ".repeat(3000);
        const recB = "REC_B ".repeat(3000);
        const poolTok = defaultCountTokens(oldA) + defaultCountTokens(oldB) + defaultCountTokens(oldC) + defaultCountTokens(oldD);
        const floorTok = defaultCountTokens(recA) + defaultCountTokens(recB);
        assert.ok(poolTok > 15_000, `foldable pool must be large (got ${poolTok})`);
        assert.ok(floorTok < WINDOW / K - 1_000, `recent floor must stay under the calibrated half-window (got ${floorTok})`);
        assert.ok(K * (poolTok + floorTok) > WINDOW, `fixture must overflow on the calibrated scale (raw ${poolTok + floorTok} × ${K})`);

        const sessionId = "issue3645-calibrated";
        seedCalibratedSession(sessionId, p.upstreamPort);

        const messages: Record<string, unknown>[] = [
            plain("user", oldA),
            plain("assistant", oldB),
            plain("user", oldC),
            plain("assistant", oldD),
            plain("user", recA),
            plain("assistant", recB),
        ];
        const resp = await post(p, sessionId, messages);
        const body = await resp.text();
        // The distinguishing signal: the walk PROCEEDS instead of skipping as futile.
        const summaries = CALLS.filter((c) => c.summary).length;
        assert.ok(summaries >= 1, `walk proceeded — ${summaries} summary call(s); the buggy raw gate made ZERO (futility skip)`);
        assert.ok(!/futile round/.test(body), `must not declare a viable fold futile (got: ${body.slice(0, 240)})`);
        assert.equal(resp.status, 200, `the recovered fold closes the gap and forwards: HTTP ${resp.status} ${body.slice(0, 240)}`);
        assert.ok(body.includes("forwarded answer"), "the model reply must reach the client");
    } finally {
        await p.cleanup();
    }
});

test("#3645 control: uncalibrated (k̂ absent) futility skip is unchanged (#1841)", async () => {
    CALLS = [];
    summaryResponder = () => ({ content: SUMMARY_TEXT, finishReason: "stop" });
    const p = await boot();
    try {
        // Same shape, NO calibration seeded (identity path). Pool tiny vs a huge
        // protected bulk → genuinely futile on the raw scale → the skip must remain.
        const REPEAT = 3157;
        const poolTok = 4 * 440;
        const estTok = 2 * Math.round((REPEAT * 22 + 45) / 4) + poolTok;
        assert.ok(estTok > WINDOW && estTok - WINDOW > poolTok * 1.2, `fixture must be raw-futile (${estTok} vs ${WINDOW}, pool ${poolTok})`);

        // No calibration seeded → identity path (k̂ absent), matching #1841 A exactly.
        const sessionId = "issue3645-control";

        const messages: Record<string, unknown>[] = [
            plain("user", "OLD_WORK_A ".repeat(160)),
            plain("assistant", "ANSWER_A ".repeat(160)),
            ...bashPair(1, REPEAT),
            ...bashPair(2, REPEAT),
            plain("user", "OLD_WORK_B ".repeat(160)),
            plain("assistant", "ANSWER_B ".repeat(160)),
            plain("user", "ok"),
            plain("assistant", "done"),
        ];
        const resp = await post(p, sessionId, messages);
        const body = await resp.text();
        assert.equal(resp.status, 413, `a raw-futile round must still fail fast non-retryably: HTTP ${resp.status} ${body.slice(0, 240)}`);
        const json = JSON.parse(body) as { error?: { code?: string; message?: string } };
        assert.equal(json.error?.code, "preflight_compress_failed");
        assert.match(json.error?.message ?? "", /futile round/, `still names the futility verdict (got: ${json.error?.message})`);
        assert.equal(CALLS.filter((c) => c.summary).length, 0, "the uncalibrated skip must spend ZERO summarization calls");
    } finally {
        await p.cleanup();
    }
});
