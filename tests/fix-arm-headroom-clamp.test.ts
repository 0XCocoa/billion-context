import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { getSession } from "../src/session.ts";
import { inspectContextOverflow, reserveOutputHeadroom } from "../src/util.ts";

// A live limb against a 1,048,576-window upstream hit an unbounded 400 loop:
//
//   upstream HTTP 400
//   {"error":{"message":"This model's maximum context length is 1048576 tokens.
//     However, you requested 1097304 tokens (841304 in the messages, 256000 in
//     the completion). Please reduce the length of the messages or completion."}}
//
// Arithmetic against the shipped code:
//   reserveOutputHeadroom(1_048_576, 256_000, 0.25)  // util.ts:355
//     cap*window = 0.25 * 1_048_576 = 262_144
//     reserved   = min(256_000, 262_144) = 256_000
//     → effective judging window = 792_576            (handle.ts:2108 → 2137)
//   messages 841_304 exceed that by 48_728, so bili KNEW the payload did not
//   fit (server.ts:3143 payloadFitsWindow === false, :3067 triggerFires === true)
//   and forwarded it anyway (the :3102 estimate-only forward-once probe).
//
// The recovery path then failed to converge: armOverflowShrink stored the RAW
// stated window (relay.ts:831 `s.stats.lastInputTokens = info.window` = 1_048_576)
// as the "usage" meter, while the kernel's nudge/truncate bands compare against
// `session.metadata.effectiveContextLimit` = the HEADROOM-RESERVED 792_576
// (handle.ts:2137). The arm therefore sat ABOVE the limit it exists to bring the
// payload under: reading the arm, every band concluded "still fits" and the
// client's re-sent history was forwarded verbatim — 400, arm, 400, arm, forever.
//
// The fix clamps the arm to min(stated, reserved), so an arm only ever lands at
// or below the limit the kernel actually judges against.

const WINDOW = 1_048_576;
const MAX_OUTPUT = 256_000;
const CAP_PCT = 0.25; // DEFAULT_OUTPUT_HEADROOM_MAX_PCT (util.ts:327)

const REJECT_BODY = JSON.stringify({
    error: {
        message:
            "This model's maximum context length is 1048576 tokens. However, you requested 1097304 tokens (841304 in the messages, 256000 in the completion). Please reduce the length of the messages or completion.",
        type: "invalid_request_error",
        param: null,
        code: "invalid_request_error",
    },
});

// The user's real payload: 841,304 tokens of messages. The test only needs the
// request to be large enough that preflight's trigger fires, so build a body of
// a realistic size with a max_tokens in the same shape as the limb's.
function bigMessages(): Array<{ role: string; content: string }> {
    const messages: Array<{ role: string; content: string }> = [];
    // ~48,730 tokens over the reserved judging limit (792,576), i.e. the limb's
    // exact overage, expressed at ~4 B/token.
    const target = 48_730 * 4;
    const per = 4_000;
    for (let n = 0; n * per < target; n++) {
        messages.push({
            role: n % 2 === 0 ? "user" : "assistant",
            content: `turn ${n}: ` + "f".repeat(per - 20),
        });
    }
    return messages;
}

type Call = { chars: number; usage: number | null };

function makeUpstream(): { server: http.Server; calls: Call[] } {
    const calls: Call[] = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            let chars = 0;
            let usage: number | null = null;
            const raw = Buffer.concat(chunks).toString("utf8");
            try {
                const parsed = JSON.parse(raw) as {
                    messages?: Array<{ content?: unknown }>;
                    max_tokens?: number;
                };
                chars = (parsed.messages ?? []).reduce(
                    (n, m) => n + (typeof m.content === "string" ? m.content.length : 0),
                    0,
                );
                if (typeof parsed.max_tokens === "number") usage = parsed.max_tokens;
            } catch {
                /* keep the zeroed counts; the body is unparseable */
            }
            calls.push({ chars, usage });
            res.writeHead(400, { "content-type": "application/json" });
            res.end(REJECT_BODY);
        });
    });
    return { server, calls };
}

function proxyOptions(routes: Record<string, object>): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: routes as ProxyOptions["routes"],
        modelContextLimit: WINDOW,
        kernelConfig: defaultConfig(WINDOW, {
            preserveRecentMessages: 2,
            preserveRecentTokens: 2000,
            compress: { minCompressRange: 1000, maxSummaryLength: 20000, minSummaryLength: 50 },
        }),
        compress: { injectTool: true, injectNudge: true },
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
        promptCache: { routing: "auto" },
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions;
}

async function setup(): Promise<{ ctx: Ctx; calls: Call[]; close: () => Promise<void> }> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const { server: upstream, calls } = makeUpstream();
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startServer(
        proxyOptions({ [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: WINDOW } } } }),
    );
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        ctx: {
            url: `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/chat/completions`,
            headers: { "content-type": "application/json", "x-acp-session": "" },
        },
        calls,
        close: async () => {
            proxy.close();
            proxy.closeIdleConnections?.();
            upstream.close();
            upstream.closeIdleConnections?.();
            await Promise.allSettled([once(proxy, "close"), once(upstream, "close")]);
        },
    };
}

type Ctx = { url: string; headers: Record<string, string> };

const post = (ctx: Ctx, messages: Array<{ role: string; content: string }>) =>
    fetch(ctx.url, {
        method: "POST",
        headers: { ...ctx.headers },
        body: JSON.stringify({ model: "gpt-test", stream: true, messages, max_tokens: MAX_OUTPUT }),
    });

test("the stated-window arm is clamped to the headroom-reserved judging limit", async () => {
    const { ctx, calls, close } = await setup();

    // The reservation the shipped code computes for this exact limb.
    const reserved = reserveOutputHeadroom(WINDOW, MAX_OUTPUT, CAP_PCT);
    assert.equal(reserved, WINDOW - MAX_OUTPUT, "sanity: 1,048,576 - 256,000 = 792,576");
    assert.equal(MAX_OUTPUT, 256_000);
    assert.ok(CAP_PCT * WINDOW >= MAX_OUTPUT, "sanity: 0.25 * 1,048,576 = 262,144 caps at maxOutput");

    // The upstream really did state 1,048,576 in the rejection body.
    const info = inspectContextOverflow(400, REJECT_BODY);
    assert.equal(info.isOverflow, true);
    assert.equal(info.window, WINDOW);

    ctx.headers["x-acp-session"] = "limb-arm-clamp";
    await post(ctx, bigMessages());

    const s = getSession("limb-arm-clamp");
    assert.ok(s, "session exists after the upstream 400");

    // The arm must be upstream-truth AND fit under the judging limit. Before
    // the fix it was `info.window` (1,048,576) — strictly above `reserved`
    // (792,576) — so no nudge band could ever fire and the client kept
    // re-sending the same oversized payload into the same 400.
    assert.equal(
        s.stats.lastInputTokensSource,
        "overflow-arm",
        "the rejection must arm the emergency shrink baseline",
    );
    assert.ok(
        s.stats.lastInputTokens < WINDOW,
        `arm ${s.stats.lastInputTokens} must sit BELOW the stated window ${WINDOW}`,
    );
    // The reserved judging limit, read exactly the way relay.ts does (a
    // `metadata` value is typed loosely, so narrow it before comparing).
    const judgingLimit =
        typeof s.metadata.effectiveContextLimit === "number" && s.metadata.effectiveContextLimit > 0
            ? s.metadata.effectiveContextLimit
            : 0;
    assert.ok(judgingLimit > 0, "handle must have recorded the reserved judging limit");
    assert.ok(
        s.stats.lastInputTokens <= judgingLimit,
        `arm ${s.stats.lastInputTokens} must be ≤ the judging limit ${judgingLimit} — ` +
            "an arm above it can never trigger the fold it exists to cause",
    );
    assert.equal(
        s.stats.lastInputTokens,
        reserved,
        "this limb: the clamp is exactly the headroom reservation",
    );
    assert.equal(s.stats.overflowArmTokens, s.stats.lastInputTokens, "overflowArmTokens mirrors the arm");

    // The request that produced the rejection must actually have carried the
    // output budget that causes the reservation — otherwise the test would be
    // asserting the clamp on a session with no headroom at all.
    assert.ok(calls.length > 0, "the upstream was reached");
    assert.equal(calls[0].usage, MAX_OUTPUT, "the forwarded request carried max_tokens 256,000");

    await close();
});

test("the stated-window arm is the upstream truth when no headroom reservation applies", async () => {
    const { ctx, calls, close } = await setup();

    // No output budget on the wire and none resolvable from the registry →
    // reserveOutputHeadroom is a no-op and the judging limit IS the declared
    // window. The clamp must not silently shrink the arm in that case: the
    // upstream-stated number is the strongest evidence available.
    const reserved = reserveOutputHeadroom(WINDOW, 0, CAP_PCT);
    assert.equal(reserved, WINDOW, "sanity: no output budget → no reservation");

    ctx.headers["x-acp-session"] = "limb-arm-unreserved";
    // Deliberately NO max_tokens — this is the control case.
    await fetch(ctx.url, {
        method: "POST",
        headers: { ...ctx.headers },
        body: JSON.stringify({ model: "gpt-test", stream: true, messages: bigMessages() }),
    });

    const s = getSession("limb-arm-unreserved");
    assert.ok(s, "session exists after the upstream 400");
    assert.equal(s.stats.lastInputTokensSource, "overflow-arm");
    assert.equal(
        s.metadata.effectiveContextLimit,
        WINDOW,
        "control: with no output budget no headroom reservation is recorded",
    );
    assert.equal(
        s.stats.lastInputTokens,
        WINDOW,
        "with no reservation the arm stays at the exact stated window",
    );
    assert.ok(calls.length > 0, "the upstream was reached");
    assert.notEqual(calls[0].usage, MAX_OUTPUT, "control: no max_tokens was forwarded");

    await close();
});
