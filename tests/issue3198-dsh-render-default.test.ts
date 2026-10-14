import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { loadRoutes, type ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

// #3198: dsh re-serializes its own resent history non-byte-stably around
// injected ACP tags, so every newly-tagged message breaks the upstream prefix
// cache on its first resend (A/B: hit rate 85.6% -> 91.2% with renderTags=none).
// The mitigation used to require ACP_RENDER_NONE=1 per host; these tests pin
// the host-aware DEFAULT: a dsh-stamped session (x-bili-plugin: dsh) renders
// none WITHOUT any env var or config, every other host keeps text-only, and an
// EXPLICIT diagnostics.renderNone=false still disables the default.

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function freePort(): Promise<number> {
    const server = http.createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    await close(server);
    return port;
}

function upstreamServer(onBody: (path: string, body: unknown) => void): Promise<http.Server> {
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            let parsed: unknown = null;
            try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* ignore */ }
            onBody(req.url ?? "", parsed);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                id: "chatcmpl-test", object: "chat.completion", created: 0, model: "test",
                choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            }));
        });
    });
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

interface Harness { port: number; stop: () => Promise<void>; cleanup: () => void }

async function startProxy(upstream: http.Server, configJson: string): Promise<Harness> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const root = path.join(tmpdir(), `bili-3198-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const biliConfig = path.join(root, "billion-context.json");
    mkdirSync(root, { recursive: true });
    writeFileSync(biliConfig, configJson, "utf8");
    const previous = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = biliConfig;
    delete process.env.ACP_RENDER_NONE;
    const upstreamPort = (upstream.address() as { port: number }).port;
    const port = await freePort();
    const opts: ProxyOptions = {
        port,
        host: "127.0.0.1",
        upstream: `http://127.0.0.1:${upstreamPort}`,
        routes: loadRoutes(),
        proxy: "",
        proxyMode: "direct",
        proxySource: "direct",
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: false, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        chainContentDetection: false,
        passthroughSource: null,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    if (!proxy.listening) await once(proxy, "listening");
    return {
        port,
        stop: async () => { await close(proxy); },
        cleanup: () => {
            if (previous === undefined) delete process.env.BILI_CONFIG_FILE; else process.env.BILI_CONFIG_FILE = previous;
            rmSync(root, { recursive: true, force: true });
        },
    };
}

const CHAT_BODY = JSON.stringify({
    model: "test",
    max_tokens: 1000,
    messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
        { role: "user", content: "what did we say?" },
    ],
});

type Msg = { role?: string; content?: unknown };

function chatAssistantText(fwd: Record<string, unknown>): string {
    const msgs = fwd.messages as Msg[] | undefined;
    assert.ok(Array.isArray(msgs), "forwarded body carries messages");
    const a = msgs.find((m) => m.role === "assistant");
    assert.ok(a, "the assistant message reaches the upstream");
    return typeof a.content === "string" ? a.content : JSON.stringify(a.content);
}

function chatSystemText(fwd: Record<string, unknown>): string {
    const msgs = fwd.messages as Msg[] | undefined;
    assert.ok(Array.isArray(msgs), "forwarded body carries messages");
    const sys = msgs.find((m) => m.role === "system");
    assert.ok(sys, "a system message reaches the upstream");
    return typeof sys.content === "string" ? sys.content : JSON.stringify(sys.content);
}

test("#3198 dsh-stamped session: renderTags defaults to none without any env var", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const upstream = await upstreamServer((_path, body) => seen.push(body as Record<string, unknown>));
    const harness = await startProxy(upstream, `{"providers":{}}`);
    try {
        const res = await fetch(`http://127.0.0.1:${harness.port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-session-id": "issue3198-dsh-default", "x-bili-plugin": "dsh" },
            body: CHAT_BODY,
        });
        assert.equal(res.status, 200);
        assert.equal(seen.length, 1);
        assert.equal(chatAssistantText(seen[0]!), "hi there", "dsh default forwards the assistant text byte-identical (no tag injection)");
        assert.ok(!chatSystemText(seen[0]!).includes("NEVER echo"), "tags-only prompt follows the rendered tags (#1881)");
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});

test("#3198 non-dsh session: renderTags stays text-only by default (no behavior drift)", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const upstream = await upstreamServer((_path, body) => seen.push(body as Record<string, unknown>));
    const harness = await startProxy(upstream, `{"providers":{}}`);
    try {
        const res = await fetch(`http://127.0.0.1:${harness.port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-session-id": "issue3198-nondsh-default" },
            body: CHAT_BODY,
        });
        assert.equal(res.status, 200);
        assert.equal(seen.length, 1);
        assert.ok(chatAssistantText(seen[0]!).startsWith("<acp tokens="), `non-dsh default still tags assistant text, got: ${JSON.stringify(chatAssistantText(seen[0]!).slice(0, 40))}`);
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});

test("#3198 explicit diagnostics.renderNone=false beats the dsh host default", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const upstream = await upstreamServer((_path, body) => seen.push(body as Record<string, unknown>));
    const harness = await startProxy(upstream, `{"providers":{},"diagnostics":{"renderNone":false}}`);
    try {
        const res = await fetch(`http://127.0.0.1:${harness.port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-session-id": "issue3198-dsh-explicit-off", "x-bili-plugin": "dsh" },
            body: CHAT_BODY,
        });
        assert.equal(res.status, 200);
        assert.equal(seen.length, 1);
        assert.ok(chatAssistantText(seen[0]!).startsWith("<acp tokens="), `explicit file false re-enables tags on dsh sessions, got: ${JSON.stringify(chatAssistantText(seen[0]!).slice(0, 40))}`);
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});
