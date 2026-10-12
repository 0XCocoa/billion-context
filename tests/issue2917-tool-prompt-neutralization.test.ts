// #2917: tool prompts are ambient configuration, not conversation
// identity. The dsh host renders the plugin manifest's tool descriptions
// INTO the main system message; bili's own upgrades rewrite those strings
// (kernel 540f44028 reworded the compress tool, 55473→55496 chars — only
// the tool line changed) and users install plugins mid-session (new tool
// lines appear). Neither event may fork the main lane off the raw key:
// the persona fingerprint hashes the system text with every
// request-declared tool description REMOVED. A real persona edit
// (AGENTS.md) and the review persona still fork; #2601 model-drift
// absorption keeps working and now survives a simultaneous tool rewrite.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import type { ProxyOptions } from "../src/config.ts";

// Hermetic state dirs BEFORE importing the server modules (#2601 idiom).
const testRoot = mkdtempSync(path.join(tmpdir(), "bc-2917-toolprompt-"));
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = testRoot;

const { prefixAffinity } = await import("../src/prefix-affinity.ts");
const { resolvePersonaKey, personaAnchorOf, neutralizeToolPrompts, resetPersonaAnchorsForTest } = await import(
    "../src/persona-anchor.ts"
);

test.after(() => rmSync(testRoot, { recursive: true, force: true }));

// The #2917 shape: a long persona text with the manifest's tool
// descriptions rendered in (the real system is ~55K chars / 1175 lines;
// only the tool line changes across the upgrade).
const DESC_V1 = "Compress the conversation history into a summary. Target the exchange graph, no JSON structure required.";
const DESC_V2 =
    "Compress the conversation history into a summary. Target the exchange graph, preserving every open question, no JSON structure required.";
const DESC_SEARCH = "Search the workspace for a symbol or free-text query and return the ranked matches with line numbers.";

const systemWith = (...toolLines: string[]): string =>
    `You are DeepSeek Harness, the main coding agent.\nModel: GLM-4.6.\n` +
    toolLines.map((d) => `- ${d}`).join("\n") +
    `\nWorkspace: /tmp.\nAnswer in the user's language.`;

const SYSTEM_V1 = systemWith(`compress: ${DESC_V1}`);
const SYSTEM_V2 = systemWith(`compress: ${DESC_V2}`);
const SYSTEM_PLUGIN = systemWith(`compress: ${DESC_V2}`, `search: ${DESC_SEARCH}`);

const TOOLS_V1 = [{ name: "compress", description: DESC_V1 }];
const TOOLS_V2 = [{ name: "compress", description: DESC_V2 }];
const TOOLS_PLUGIN = [...TOOLS_V2, { name: "search", description: DESC_SEARCH }];

const NEUTRALIZED = `You are DeepSeek Harness, the main coding agent.\nModel: GLM-4.6.\nWorkspace: /tmp.\nAnswer in the user's language.`;
const fpOf = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
const forkKey = (conv: string, system: string): string => `${conv}|sub:${fpOf(system)}`;

const msgs = (n: number, tag: string): { role: string; content: string }[] =>
    Array.from({ length: n }, (_, i): { role: string; content: string } => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `${tag}-${i + 1}-` + "z".repeat(120),
    }));

function seed(conv: string, chain: { role: string; content: string }[]): void {
    resetPersonaAnchorsForTest();
    prefixAffinity.forget(conv);
    const fp = prefixAffinity.chainFingerprint(chain);
    assert.ok(fp, "chain fingerprint exists");
    prefixAffinity.note(conv, fp.depth, fp.tailHash, fp.itemHashes, true);
}

test("neutralizeToolPrompts: removes descriptions from all three wire shapes", () => {
    // anthropic / responses flat shape
    assert.equal(neutralizeToolPrompts(SYSTEM_V1, TOOLS_V1), NEUTRALIZED);
    // openai chat nested shape
    const nested = [{ type: "function", function: { name: "compress", description: DESC_V1 } }];
    assert.equal(neutralizeToolPrompts(SYSTEM_V1, nested), NEUTRALIZED);
    // multiple tools, dedup, non-objects and short strings ignored
    const noisy = [null, 7, "x", { description: "short" }, TOOLS_V1[0], TOOLS_V1[0]];
    assert.equal(neutralizeToolPrompts(SYSTEM_V1, noisy), NEUTRALIZED);
    // absent description stays conservative (fragment remains)
    assert.equal(neutralizeToolPrompts(SYSTEM_V1, undefined), SYSTEM_V1);
});

test("#2917 replay: bili upgrade rewrites the compress description mid-conversation — anchor MATCHES, no fork", () => {
    const conv = "2917-upgrade";
    const chainA = msgs(6, "a");
    seed(conv, chainA);
    // restart: first arrival claims with the OLD rendered prompt + OLD tools
    assert.deepEqual(resolvePersonaKey(conv, SYSTEM_V1, chainA, "glm-4.6", TOOLS_V1), { key: conv, action: "claim" });
    // 0.35s later the NEW system text arrives with the NEW tools declaration
    assert.deepEqual(resolvePersonaKey(conv, SYSTEM_V2, chainA, "glm-4.6", TOOLS_V2), { key: conv, action: "match" });
    assert.equal(personaAnchorOf(conv), fpOf(NEUTRALIZED), "fp is the neutralized text");
});

test("plugin install adds a tool mid-conversation — anchor MATCHES, no fork", () => {
    const conv = "2917-plugin";
    const chainA = msgs(6, "p");
    seed(conv, chainA);
    assert.deepEqual(resolvePersonaKey(conv, SYSTEM_V2, chainA, "glm-4.6", TOOLS_V2), { key: conv, action: "claim" });
    // user installs a plugin: a new tool line appears in the system text
    // AND a new declaration rides the tools array.
    assert.deepEqual(resolvePersonaKey(conv, SYSTEM_PLUGIN, chainA, "glm-4.6", TOOLS_PLUGIN), { key: conv, action: "match" });
    // and the old build (no search tool) still matches after that
    assert.deepEqual(resolvePersonaKey(conv, SYSTEM_V2, chainA, "glm-4.6", TOOLS_V2), { key: conv, action: "match" });
});

test("a REAL persona edit still forks (tool neutralization must not swallow persona drift)", () => {
    const conv = "2917-persona-edit";
    const chainA = msgs(6, "e");
    seed(conv, chainA);
    assert.deepEqual(resolvePersonaKey(conv, SYSTEM_V2, chainA, "glm-4.6", TOOLS_V2), { key: conv, action: "claim" });
    // AGENTS.md edit rewrites a persona line AND the history is fresh (new
    // task reusing the id) — the designed fork must survive.
    const edited = SYSTEM_V2.replace("Answer in the user's language.", "Always answer in Chinese.");
    const fresh = msgs(2, "fresh-e");
    assert.deepEqual(resolvePersonaKey(conv, edited, fresh, "glm-4.6", TOOLS_V2), {
        key: forkKey(conv, neutralizeToolPrompts(edited, TOOLS_V2)),
        action: "fork",
    });
});

test("review persona (different system, no shared tool text) still forks", () => {
    const conv = "2917-review";
    const chainA = msgs(6, "r");
    seed(conv, chainA);
    assert.deepEqual(resolvePersonaKey(conv, SYSTEM_V2, chainA, "glm-4.6", TOOLS_V2), { key: conv, action: "claim" });
    const reviewSystem = "You are the final authorization reviewer for exactly one pending tool call.\nAnswer with one word.";
    const reviewBlob = msgs(1, "review-blob");
    assert.deepEqual(resolvePersonaKey(conv, reviewSystem, reviewBlob, "glm-4.6", TOOLS_V2), {
        key: forkKey(conv, reviewSystem),
        action: "fork",
    });
});

test("#2601 model-switch absorption survives a simultaneous tool-description rewrite", () => {
    const conv = "2917-model-and-tool";
    const chainA = msgs(6, "m");
    seed(conv, chainA);
    const sysA = systemWith(`compress: ${DESC_V1}`).replace("GLM-4.6", "GLM-4.6");
    assert.deepEqual(resolvePersonaKey(conv, sysA, chainA, "glm-4.6", TOOLS_V1), { key: conv, action: "claim" });
    // model line change + tool description change in the same window, with
    // a discontinued chain (the #2601 residual conjunction): neutralization
    // makes the tool line IDENTICAL on both sides, so the line-diff is
    // confined to the model identity lines → absorbed.
    const sysB = systemWith(`compress: ${DESC_V2}`).replace("GLM-4.6", "GLM-5.3");
    const fresh = msgs(2, "fresh-m");
    assert.deepEqual(resolvePersonaKey(conv, sysB, fresh, "glm-5.3", TOOLS_V2), { key: conv, action: "migrate-model" });
});

test("a system text that is ONLY tool prompts passes through un-anchored", () => {
    assert.deepEqual(resolvePersonaKey("2917-passthrough", `- ${DESC_V1}`, [], undefined, TOOLS_V1), {
        key: "2917-passthrough",
        action: "passthrough",
    });
});

// ---------------------------------------------------------------------------
// Server-level wiring (review addition): handle.ts passes `tools` into
// personaNamespace as an OPTIONAL positional arg — dropping it compiles
// clean and the unit tests above stay green. Pin the openai lane (dsh's
// wire) end-to-end on a DISCONTINUOUS history so only the MATCH rung can
// keep the raw key; a real persona edit in the same shape must still fork
// (negative control, so the match cannot pass trivially).
// ---------------------------------------------------------------------------

const WIRE_MODEL = "claude-sonnet-4-5";
const WIRE_CONV = "2917-wire-openai";

async function startWireRig(): Promise<{ url: string; close: () => Promise<void> }> {
    const { startServer } = await import("../src/server.ts");
    const { defaultConfig } = await import("acp-kernel");
    const { SessionStore, _setStoreForTest } = await import("../src/persist.ts");
    const { _setForTest: setRegistryForTest } = await import("../src/registry.ts");
    const { _resetPluginStateForTest } = await import("../src/plugin.ts");
    const { _resetSessionsForTest } = await import("../src/session.ts");

    const upstream = http.createServer((req, res) => {
        let b = "";
        req.on("data", (c: Buffer) => (b += c.toString("utf8")));
        req.on("end", () => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                id: "chatcmpl-1",
                object: "chat.completion",
                choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
            }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetSessionsForTest();
    _resetPluginStateForTest();
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: {} },
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000),
        compress: { injectTool: true, injectNudge: false },
        promptCache: { routing: "auto" },
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
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        url: `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`,
        close: async () => {
            proxy.close();
            await once(proxy, "close");
            upstream.close();
            await once(upstream, "close");
        },
    };
}

test("e2e openai lane wiring: rewrite rides body.tools → MATCH on raw key; persona edit in the same shape still forks", async () => {
    const { getSession, peekSession } = await import("../src/session.ts");
    resetPersonaAnchorsForTest();
    prefixAffinity.forget(WIRE_CONV);

    const rig = await startWireRig();
    try {
        const headers: Record<string, string> = {
            "content-type": "application/json",
            "x-bili-plugin": "dsh",
            "x-bili-plugin-conversation": WIRE_CONV,
        };
        const oiTool = (name: string, description: string) => ({
            type: "function",
            function: { name, description, parameters: { type: "object", properties: {} } },
        });
        // A bili ACP tool alone demotes the request via #1897 (leaked-tools
        // side passthrough) before persona resolution runs — real dsh main
        // turns always carry host action tools alongside the ACP tools.
        const HOST_TOOL = oiTool("bash", "Run a shell command in the workspace");

        // Claim with the v1 render + v1 tools declaration.
        const r1 = await fetch(rig.url, {
            method: "POST",
            headers,
            body: JSON.stringify({
                model: WIRE_MODEL,
                max_tokens: 64_000,
                tools: [HOST_TOOL, oiTool("compress", DESC_V1)],
                messages: [{ role: "system", content: SYSTEM_V1 }, ...msgs(6, "w")],
            }),
        });
        assert.equal(r1.status, 200);
        await r1.text();
        assert.equal(getSession(WIRE_CONV)?.stats.requests, 1, "claim lands on the raw key");

        // Upgrade shape: v2 render + v2 declaration with a DISCONTINUOUS
        // (fresh) history — isolates the MATCH rung. If handle.ts dropped
        // `tools`, the fingerprints differ and no other rung rescues the key.
        const r2 = await fetch(rig.url, {
            method: "POST",
            headers,
            body: JSON.stringify({
                model: WIRE_MODEL,
                max_tokens: 64_000,
                tools: [HOST_TOOL, oiTool("compress", DESC_V2)],
                messages: [{ role: "system", content: SYSTEM_V2 }, ...msgs(2, "w-fresh")],
            }),
        });
        assert.equal(r2.status, 200);
        await r2.text();
        assert.equal(getSession(WIRE_CONV)?.stats.requests, 2, "rewritten description matched the raw key end-to-end");
        assert.equal(peekSession(forkKey(WIRE_CONV, SYSTEM_V2)), undefined, "no ghost under the un-neutralized fp");
        assert.equal(peekSession(forkKey(WIRE_CONV, NEUTRALIZED)), undefined, "no ghost under the neutralized fp either");

        // Negative control: a REAL persona edit (non-tool line) in the same
        // shape must still fork — proves the match above is not trivial.
        const edited = SYSTEM_V2.replace("Answer in the user's language.", "Always answer in Chinese.");
        const r3 = await fetch(rig.url, {
            method: "POST",
            headers,
            body: JSON.stringify({
                model: WIRE_MODEL,
                max_tokens: 64_000,
                tools: [HOST_TOOL, oiTool("compress", DESC_V2)],
                messages: [{ role: "system", content: edited }, ...msgs(2, "w-edit")],
            }),
        });
        assert.equal(r3.status, 200);
        await r3.text();
        assert.ok(
            peekSession(forkKey(WIRE_CONV, neutralizeToolPrompts(edited, [HOST_TOOL, oiTool("compress", DESC_V2)]))),
            "persona edit forks onto its own namespace",
        );
        assert.equal(getSession(WIRE_CONV)?.stats.requests, 2, "persona edit did not touch the raw session");
    } finally {
        await rig.close();
    }
});
