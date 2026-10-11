// #2601 B': header-corroborated model-drift absorption. With #2719's
// churn-tolerant continuity, a plain model switch MIGRATES the persona
// anchor. The residual fork shape is the CONJUNCTION: the model switch
// (fp changes) lands in the same window as an unannounced history rewrite
// (chain discontinuity — e.g. dsh local compaction) and the main lane
// still forks. dsh declares its model target on every request via
// x-bili-plugin-model (src/agent/dsh-native.ts); this suite pins the
// absorption rule that consumes BOTH host declarations: the header model
// changed AND the system line-diff is confined to the model identity
// lines → the fp half of the conjunction is absorbed (migrate-model, raw
// key). Anything less — no header, same header model, extra changed lines,
// line-count drift, a genuinely different (review) system — keeps forking.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

// Hermetic state dirs BEFORE importing the server modules (the prefix
// affinity snapshot persists across runs otherwise — #2719 test idiom).
const testRoot = mkdtempSync(path.join(tmpdir(), "bc-2601-absorb-"));
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = testRoot;

const { prefixAffinity } = await import("../src/prefix-affinity.ts");
const { resolvePersonaKey, personaAnchorOf, personaNamespace, resetPersonaAnchorsForTest } = await import("../src/persona-anchor.ts");

test.after(() => rmSync(testRoot, { recursive: true, force: true }));

const SYSTEM_A = "You are DeepSeek Harness, the main coding agent.\nModel: GLM-4.6.\nWorkspace: /tmp.";
const SYSTEM_B = "You are DeepSeek Harness, the main coding agent.\nModel: GLM-5.3.\nWorkspace: /tmp.";
const SYSTEM_WORKSPACE = "You are DeepSeek Harness, the main coding agent.\nModel: GLM-5.3.\nWorkspace: /other.";
const SYSTEM_EXTRA_LINE = SYSTEM_B + "\nExtra rule line.";
const SYSTEM_DISPLAY_A = "You are DeepSeek Harness, the main coding agent.\nModel: GLM 4.6 Pro.\nWorkspace: /tmp.";
const SYSTEM_DISPLAY_B = "You are DeepSeek Harness, the main coding agent.\nModel: GLM 5.3 Air.\nWorkspace: /tmp.";
const REVIEW_SYSTEM = "You are the final authorization reviewer for exactly one pending tool call.\nAnswer with one word.";

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

test("resolvePersonaKey: a header-corroborated model switch with a discontinued chain MIGRATES (#2601)", () => {
    const conv = "absorb-1";
    const chainA = msgs(6, "a");
    seed(conv, chainA);
    assert.deepEqual(resolvePersonaKey(conv, SYSTEM_A, chainA, "glm-4.6"), { key: conv, action: "claim" });
    // Same window as an unannounced history rewrite: fresh messages that do
    // not continue the chain (the #2601 residual conjunction).
    const fresh = msgs(2, "fresh-1");
    assert.deepEqual(resolvePersonaKey(conv, SYSTEM_B, fresh, "glm-5.3"), { key: conv, action: "migrate-model" });
    assert.equal(personaAnchorOf(conv), fpOf(SYSTEM_B), "anchor migrated to the new system");
});

test("absorption requires BOTH host declarations: header missing on either side forks", () => {
    const conv = "absorb-2";
    const chainA = msgs(6, "b");
    seed(conv, chainA);
    resolvePersonaKey(conv, SYSTEM_A, chainA, "glm-4.6");
    const fresh = msgs(2, "fresh-2");
    // drift without a current header
    assert.deepEqual(resolvePersonaKey(conv, SYSTEM_B, fresh, undefined), { key: forkKey(conv, SYSTEM_B), action: "fork" });
    // header present now, but the anchor was claimed without one
    const conv2 = "absorb-2b";
    const chainA2 = msgs(6, "b2");
    seed(conv2, chainA2);
    resolvePersonaKey(conv2, SYSTEM_A, chainA2, undefined);
    assert.deepEqual(resolvePersonaKey(conv2, SYSTEM_B, msgs(2, "fresh-2b"), "glm-5.3"), { key: forkKey(conv2, SYSTEM_B), action: "fork" });
});

test("an unchanged header model does not corroborate a system drift", () => {
    const conv = "absorb-3";
    const chainA = msgs(6, "c");
    seed(conv, chainA);
    resolvePersonaKey(conv, SYSTEM_A, chainA, "glm-4.6");
    assert.deepEqual(resolvePersonaKey(conv, SYSTEM_B, msgs(2, "fresh-3"), "glm-4.6"), { key: forkKey(conv, SYSTEM_B), action: "fork" });
});

test("a changed non-model line in the diff defeats absorption", () => {
    const conv = "absorb-4";
    const chainA = msgs(6, "d");
    seed(conv, chainA);
    resolvePersonaKey(conv, SYSTEM_A, chainA, "glm-4.6");
    assert.deepEqual(resolvePersonaKey(conv, SYSTEM_WORKSPACE, msgs(2, "fresh-4"), "glm-5.3"), { key: forkKey(conv, SYSTEM_WORKSPACE), action: "fork" });
});

test("a line-count change defeats absorption", () => {
    const conv = "absorb-5";
    const chainA = msgs(6, "e");
    seed(conv, chainA);
    resolvePersonaKey(conv, SYSTEM_A, chainA, "glm-4.6");
    assert.deepEqual(resolvePersonaKey(conv, SYSTEM_EXTRA_LINE, msgs(2, "fresh-5"), "glm-5.3"), { key: forkKey(conv, SYSTEM_EXTRA_LINE), action: "fork" });
});

test("folded display-name variants corroborate (header key vs {{model}} render)", () => {
    const conv = "absorb-6";
    const chainA = msgs(6, "f");
    seed(conv, chainA);
    resolvePersonaKey(conv, SYSTEM_DISPLAY_A, chainA, "glm-4.6-pro");
    assert.deepEqual(resolvePersonaKey(conv, SYSTEM_DISPLAY_B, msgs(2, "fresh-6"), "glm-5.3-air"), { key: conv, action: "migrate-model" });
});

test("switching back A→B→A on discontinued chains keeps the raw key", () => {
    const conv = "absorb-7";
    const chainA = msgs(6, "g");
    seed(conv, chainA);
    resolvePersonaKey(conv, SYSTEM_A, chainA, "glm-4.6");
    assert.equal(resolvePersonaKey(conv, SYSTEM_B, msgs(2, "g1"), "glm-5.3").action, "migrate-model");
    assert.equal(resolvePersonaKey(conv, SYSTEM_A, msgs(2, "g2"), "glm-4.6").action, "migrate-model");
    assert.equal(personaAnchorOf(conv), fpOf(SYSTEM_A));
});

test("a continuing history still takes plain migrate (continuity runs first)", () => {
    const conv = "absorb-8";
    const chainA = msgs(6, "h");
    seed(conv, chainA);
    resolvePersonaKey(conv, SYSTEM_A, chainA, "glm-4.6");
    const continuing = [...chainA, { role: "user", content: "next-turn-" + "z".repeat(120) }];
    assert.deepEqual(resolvePersonaKey(conv, SYSTEM_B, continuing, "glm-5.3"), { key: conv, action: "migrate" });
});

test("an auto-review system next to a model switch still forks (line-diff is the whole system)", () => {
    const conv = "absorb-9";
    const chainA = msgs(6, "i");
    seed(conv, chainA);
    resolvePersonaKey(conv, SYSTEM_A, chainA, "glm-4.6");
    assert.deepEqual(resolvePersonaKey(conv, REVIEW_SYSTEM, msgs(2, "fresh-9"), "glm-5.3"), { key: forkKey(conv, REVIEW_SYSTEM), action: "fork" });
});

test("a same-system alias re-declaration refreshes the recorded model for a later absorption", () => {
    const conv = "absorb-10";
    const chainA = msgs(6, "j");
    seed(conv, chainA);
    resolvePersonaKey(conv, SYSTEM_A, chainA, "glm-4.6");
    // alias switch: header re-declared, {{model}} render unchanged
    assert.deepEqual(resolvePersonaKey(conv, SYSTEM_A, chainA, "glm-4.6-alias"), { key: conv, action: "match" });
    // the NEXT real switch absorbs against the freshest declared name
    assert.deepEqual(resolvePersonaKey(conv, SYSTEM_B, msgs(2, "fresh-10"), "glm-5.3"), { key: conv, action: "migrate-model" });
});

test("personaNamespace surfaces the absorbed migration in the log", () => {
    const conv = "absorb-11";
    const chainA = msgs(6, "k");
    seed(conv, chainA);
    const logs: string[] = [];
    const log = (_l: "info" | "warn" | "error", m: string): void => {
        logs.push(m);
    };
    personaNamespace(conv, SYSTEM_A, chainA, log, "glm-4.6");
    assert.equal(personaNamespace(conv, SYSTEM_B, msgs(2, "fresh-11"), log, "glm-5.3"), conv);
    assert.ok(logs.some((m) => m.includes("header-corroborated model switch") && m.includes("#2601")), "absorbed migration is logged");
});
