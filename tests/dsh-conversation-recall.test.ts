/**
 * #4082 negotiated conversation recall — dsh gate wiring stakes.
 *
 * The dsh takeover gate refuses dispatches whose host attribution is missing
 * (#3918: quota/429 retries and model switches run outside the agent scope,
 * so the AsyncLocalStorage initiator is absent and the request goes DIRECT —
 * uncompressed, unguarded, permanently for the session).
 *
 * The recall wiring learns (lane → sid, boundary) on every ATTRIBUTED
 * dispatch in beforeSend, and when the gate later sees an unattributed
 * dispatch whose body history contains a remembered boundary, it claims the
 * request and beforeSend stamps the negotiated conversation header, so the
 * retry rides the plugin lane as the same session.
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strict as assert } from "node:assert";
import test from "node:test";

import {
    __resetConversationRecallForTests,
    conversationRecallStats,
} from "../src/agent/conversation-recall.ts";
import {
    _resetRegisterForTest,
    _settleNativeForTest,
    _stateBeforeSendForTest,
    _stateTakeoverGateForTest,
    _stateToolsReadyForTest,
    apply,
    type PluginContext,
} from "../src/agent/dsh-native.ts";

const POLL_DEADLINE_MS = 15000;

async function waitFor(cond: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + POLL_DEADLINE_MS;
    while (!cond()) {
        if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 10));
    }
}

/** Minimal manifest-serving proxy — registration only; no model traffic. */
async function startMockProxy(): Promise<{ origin: string; close: () => void }> {
    const server = http.createServer((req, res) => {
        const url = req.url ?? "";
        if (url === "/__bili/plugin/manifest") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                version: "0.1.119",
                tools: { anthropic: [{ name: "compress", description: "Compress a range of messages", input_schema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] } }] },
            }));
            return;
        }
        if (url === "/__bili/plugin/session-name") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            return;
        }
        res.writeHead(404);
        res.end();
    });
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as { port: number };
            resolve({ origin: `http://127.0.0.1:${addr.port}`, close: () => server.close() });
        });
    });
}

type HostCtx = ReturnType<typeof makeCtx>;

function makeCtx() {
    let initiator: { session?: { id?: unknown } } | undefined;
    const tools: unknown[] = [];
    const listeners = new Map<string, Array<(...a: unknown[]) => void>>();
    return {
        tools: { register: (t: unknown) => tools.push(t) },
        commands: { register: (_c: unknown) => undefined },
        agents: { currentInitiator: () => initiator },
        setInitiator: (i: { session?: { id?: unknown } } | undefined) => (initiator = i),
        registeredTools: tools,
        on: (event: string, listener: (...a: unknown[]) => void) => {
            (listeners.get(event) ?? listeners.set(event, []).get(event)!).push(listener);
        },
        emit: (event: string, ...args: unknown[]) => { for (const l of listeners.get(event) ?? []) l(...args); },
        inject: (_deps: readonly string[], _cb: (sub: unknown) => void) => undefined,
    };
}

const MODEL_URL = "https://api.anthropic.com/v1/messages";

function bodyOf(messages: Array<{ role: string; content: string }>, model = "claude-x"): string {
    return JSON.stringify({ model, max_tokens: 1024, stream: true, system: "be brief", messages });
}

async function withSetup(fn: (host: HostCtx, proxy: { origin: string }) => Promise<void>): Promise<void> {
    __resetConversationRecallForTests();
    const proxy = await startMockProxy();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-recall-"));
    const saved: Array<[string, string | undefined]> = [];
    for (const key of ["BILLION_CONTEXT_PROXY", "DSH_HOME", "BILI_PROVIDER_REWRITES", "BILI_NATIVE_DSH", "BILLION_CONTEXT_PLUGIN"]) {
        saved.push([key, process.env[key]]);
    }
    process.env.BILLION_CONTEXT_PROXY = proxy.origin;
    process.env.DSH_HOME = home;
    delete process.env.BILI_PROVIDER_REWRITES;
    delete process.env.BILI_NATIVE_DSH;
    delete process.env.BILLION_CONTEXT_PLUGIN;
    _resetRegisterForTest(proxy.origin);
    const ctx = makeCtx();
    apply(ctx as unknown as PluginContext);
    try {
        await waitFor(() => ctx.registeredTools.length === 1, "manifest tool registration");
        await fn(ctx, proxy);
    } finally {
        await _settleNativeForTest();
        for (const [key, value] of saved) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        proxy.close();
        fs.rmSync(home, { recursive: true, force: true });
    }
}

test("dsh recall: attributed dispatch learns; broken-attribution retry is claimed and stamped", async () => {
    await withSetup(async (ctx) => {
        const beforeSend = _stateBeforeSendForTest();
        const gate = _stateTakeoverGateForTest();
        assert.ok(beforeSend !== undefined && gate !== undefined);

        // Turn 1 — attribution works. beforeSend learns the lane boundary.
        ctx.setInitiator({ session: { id: "sess-alpha" } });
        const authHeaders = { authorization: "Bearer sk-live-1", "content-type": "application/json" };
        const init1: RequestInit = { method: "POST", headers: authHeaders, body: bodyOf([
            { role: "user", content: "investigate the flaky test" },
            { role: "assistant", content: "it is a port race in the harness" },
        ]) };
        await beforeSend(MODEL_URL, init1);
        assert.equal(conversationRecallStats().learned, 1, "attributed dispatch teaches the table");
        assert.equal(await gate(MODEL_URL, { bytes: 400 }), true, "attributed gate still claims");

        // Turn 2 — the host retries from a different execution chain: no
        // initiator. Same history (retry shape), maybe a different model.
        ctx.setInitiator(undefined);
        const init2: RequestInit = { method: "POST", headers: { ...authHeaders }, body: bodyOf([
            { role: "user", content: "investigate the flaky test" },
            { role: "assistant", content: "it is a port race in the harness" },
        ], "claude-y") };
        assert.equal(await gate(MODEL_URL, { bytes: 400 }, init2), true, "negotiated recall claims the retry (#3918 shape)");

        // beforeSend stamps the negotiated conversation header atomically
        // with the body (#3370 discipline) so the proxy binds the same session.
        await beforeSend(MODEL_URL, init2);
        const headers = init2.headers as Record<string, string>;
        assert.equal(headers["x-bili-plugin"], "dsh");
        assert.equal(headers["x-bili-plugin-conversation"], "sess-alpha");
    });
});

test("dsh recall: fork-shaped divergence is NOT claimed — direct behavior preserved", async () => {
    await withSetup(async (ctx) => {
        const beforeSend = _stateBeforeSendForTest();
        const gate = _stateTakeoverGateForTest();
        assert.ok(beforeSend !== undefined && gate !== undefined);

        ctx.setInitiator({ session: { id: "sess-beta" } });
        const init1: RequestInit = { method: "POST", headers: { authorization: "Bearer sk-live-2" }, body: bodyOf([
            { role: "user", content: "shared opening question" },
            { role: "assistant", content: "shared answer closes the parent turn" },
        ]) };
        await beforeSend(MODEL_URL, init1);

        // A fork replays the shared PREFIX but diverges before the parent's
        // latest boundary — no claim, no stamp, today's refusal stands.
        ctx.setInitiator(undefined);
        const init2: RequestInit = { method: "POST", headers: { authorization: "Bearer sk-live-2" }, body: bodyOf([
            { role: "user", content: "shared opening question" },
            { role: "user", content: "fork: take a completely different approach" },
        ]) };
        assert.equal(await gate(MODEL_URL, { bytes: 400 }, init2), false, "no boundary evidence — gate refuses as today");
        await beforeSend(MODEL_URL, init2);
        const headers = init2.headers as Record<string, string>;
        assert.equal(headers["x-bili-plugin-conversation"], undefined, "never stamped without evidence");
    });
});
