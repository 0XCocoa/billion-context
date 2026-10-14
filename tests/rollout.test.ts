import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

// #3062: feature-rollout gating — stable per-install identity, prefix-stable
// bucketing (percent raises never drop an install), nested rollouts
// (base-scoped cohorts), and the env > config > bucket precedence ladder.

const root = mkdtempSync(path.join(tmpdir(), "rollout-"));
const stateRoot = mkdtempSync(path.join(tmpdir(), "rollout-state-"));
const cfgFile = path.join(root, "billion-context.json");

const previousConfigFile = process.env.BILI_CONFIG_FILE;
const previousStateHome = process.env.XDG_STATE_HOME;
process.env.BILI_CONFIG_FILE = cfgFile;
process.env.XDG_STATE_HOME = stateRoot;

const rollout = await import("../src/rollout.js");
import type { RolloutCtx, RolloutDecision, RolloutPlan, RolloutSource } from "../src/rollout.js";

function setConfig(obj: unknown): void {
    writeFileSync(cfgFile, JSON.stringify(obj, null, 2), "utf8");
}

function withEnv(vars: Record<string, string>, fn: () => void): void {
    const saved: [string, string | undefined][] = [];
    for (const [k, v] of Object.entries(vars)) { saved.push([k, process.env[k]]); process.env[k] = v; }
    try { fn(); } finally {
        for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
}

function decide(feature: string, id: string, file?: RolloutCtx["file"], env?: RolloutCtx["env"]): RolloutDecision {
    return rollout.resolveRollout(feature, { id, env, file });
}

/** Register throwaway features in the version registry; restore on exit. */
function withFeatures(features: Record<string, RolloutPlan>, fn: () => void): void {
    const saved = Object.keys(features);
    try {
        Object.assign(rollout.ROLLOUT_FEATURES, features);
        fn();
    } finally {
        for (const k of saved) delete rollout.ROLLOUT_FEATURES[k];
    }
}

const ids = Array.from({ length: 4000 }, () => randomUUID());
const atPercent = (p: number, salt: string | undefined, feature = "t") =>
    ids.filter((id) => rollout.resolveRollout(feature, {
        id,
        env: {},
        file: { features: { [feature]: { percent: p, salt } } },
    }).enabled).length;

test("env name derivation: camelCase/kebab/space fold to UPPER_SNAKE", () => {
    assert.equal(rollout.rolloutEnvName("simhashV2"), "BILI_ROLLOUT_SIMHASH_V2");
    assert.equal(rollout.rolloutEnvName("fold-guard"), "BILI_ROLLOUT_FOLD_GUARD");
    assert.equal(rollout.rolloutEnvName("text safe scan"), "BILI_ROLLOUT_TEXT_SAFE_SCAN");
});

test("bucket: deterministic, in range, id-independent of percent", () => {
    const id = randomUUID();
    assert.equal(rollout.rolloutBucket("salt", id), rollout.rolloutBucket("salt", id));
    const b = rollout.rolloutBucket("salt", id);
    assert.ok(b >= 0 && b < rollout.BP_MAX);
    assert.notEqual(b, rollout.rolloutBucket("other-salt", id));
});

test("unknown feature with no config is OFF (fail closed)", () => {
    const d = rollout.resolveRollout("never-shipped", { id: randomUUID(), env: {}, file: {} });
    assert.equal(d.enabled, false);
    assert.equal(d.source, "off");
});

test("percent 0 / 100 are total off / total on", () => {
    withFeatures({ t: { percent: 100 } }, () => {
        for (const id of ids.slice(0, 50)) {
            assert.equal(rollout.resolveRollout("t", { id, env: {}, file: {} }).enabled, true);
        }
    });
    withFeatures({ t: { percent: 0 } }, () => {
        for (const id of ids.slice(0, 50)) {
            assert.equal(rollout.resolveRollout("t", { id, env: {}, file: {} }).enabled, false);
        }
    });
});

test("precedence: env > config enabled > config percent > registry percent", () => {
    withFeatures({ t: { percent: 0 } }, () => {
        const id = ids[0];
        // registry says 0% → off
        assert.equal(rollout.resolveRollout("t", { id, env: {}, file: {} }).enabled, false);
        // config percent overrides the registry
        assert.equal(rollout.resolveRollout("t", { id, env: {}, file: { features: { t: { percent: 100 } } } }).enabled, true);
        // config enabled beats percent
        assert.equal(rollout.resolveRollout("t", { id, env: {}, file: { features: { t: { enabled: true, percent: 0 } } } }).enabled, true);
        assert.equal(rollout.resolveRollout("t", { id, env: {}, file: { features: { t: { enabled: false, percent: 100 } } } }).enabled, false);
        // env beats everything; 0/false = off, any other value = on
        assert.equal(rollout.resolveRollout("t", { id, env: { BILI_ROLLOUT_T: "0" }, file: { features: { t: { enabled: true } } } }).enabled, false);
        assert.equal(rollout.resolveRollout("t", { id, env: { BILI_ROLLOUT_T: "false" }, file: { features: { t: { enabled: true } } } }).enabled, false);
        assert.equal(rollout.resolveRollout("t", { id, env: { BILI_ROLLOUT_T: "1" }, file: { features: { t: { enabled: false } } } }).enabled, true);
        assert.equal(rollout.resolveRollout("t", { id, env: { BILI_ROLLOUT_T: "yes" }, file: {} }).enabled, true);
    });
});

test("invalid config percent falls through (garbage never widens a cohort)", () => {
    withFeatures({ t: { percent: 0 } }, () => {
        for (const bad of [-5, 101, Number.NaN, Number.POSITIVE_INFINITY]) {
            const d = rollout.resolveRollout("t", { id: ids[0], env: {}, file: { features: { t: { percent: bad } } } });
            assert.equal(d.enabled, false, `percent ${bad} must fall through to the registry value`);
        }
    });
});

test("monotonicity: raising percent never drops an enabled install", () => {
    withFeatures({ t: { percent: 1.37 } }, () => {
        const enabledAtLow = new Set(ids.filter((id) => rollout.resolveRollout("t", { id, env: {}, file: {} }).enabled));
        assert.ok(enabledAtLow.size > 20 && enabledAtLow.size < 200, `sanity: ~55 expected at 1.37%, got ${enabledAtLow.size}`);
        for (const p of [5, 20, 50, 99.9]) {
            for (const id of enabledAtLow) {
                assert.equal(
                    decide("t", id, { features: { t: { percent: p } } }).enabled,
                    true,
                    `install enabled at 1.37% must stay enabled at ${p}%`,
                );
            }
        }
    });
});

test("distribution sanity: ~10% of installs at percent 10", () => {
    const n = atPercent(10, "s");
    assert.ok(n > 320 && n < 480, `expected ~400/4000 at 10%, got ${n}`);
});

test("salt change re-randomizes the cohort", () => {
    const a = new Set(ids.filter((id) => rollout.rolloutBucket("salt-a", id) < 1000));
    const b = new Set(ids.filter((id) => rollout.rolloutBucket("salt-b", id) < 1000));
    assert.ok(a.size > 320 && a.size < 480, `cohort A sanity: ${a.size}`);
    assert.ok(b.size > 320 && b.size < 480, `cohort B sanity: ${b.size}`);
    let overlap = 0;
    for (const id of a) if (b.has(id)) overlap++;
    // independent 10%×10% ⇒ expect ~40 (σ≈6.3); >100 means the salts collide.
    assert.ok(overlap < 100, `salt change must reshuffle; overlap ${overlap}`);
});

test("nested rollout: B evaluated only inside A's cohort, percent relative to it", () => {
    withFeatures({ a: { percent: 100 }, b: { percent: 50, base: "a" } }, () => {
        // A at 100% ⇒ everyone is in A ⇒ B's 50% applies to everyone.
        let on = 0;
        for (const id of ids) if (rollout.resolveRollout("b", { id, env: {}, file: {} }).enabled) on++;
        assert.ok(on > 1850 && on < 2150, `B≈50% of A(=all), got ${on}/4000`);
        assert.ok(on > 0 && on < 4000, "both outcomes must exist");
    });
    withFeatures({ a: { percent: 0 }, b: { percent: 100, base: "a" } }, () => {
        // A off ⇒ B off even at 100%.
        for (const id of ids.slice(0, 50)) {
            const d = rollout.resolveRollout("b", { id, env: {}, file: {} });
            assert.equal(d.enabled, false);
            assert.equal(d.base, "a");
        }
    });
    // A at 25% ⇒ B(50% of A) lands ≈12.5% of everyone.
    withFeatures({ a: { percent: 25 }, b: { percent: 50, base: "a" } }, () => {
        let on = 0;
        for (const id of ids) if (rollout.resolveRollout("b", { id, env: {}, file: {} }).enabled) on++;
        assert.ok(on > 380 && on < 620, `B≈12.5% of all, got ${on}/4000`);
    });
    // config override re-scopes the nesting: b.base -> a2.
    withFeatures({ a2: { percent: 100 }, b: { percent: 0, base: "a" } }, () => {
        assert.equal(rollout.resolveRollout("b", { id: ids[0], env: {}, file: { features: { b: { base: "a2", percent: 100 } } } }).enabled, true);
    });
});

test("base cycles fail closed without hanging", () => {
    withFeatures({ x: { percent: 100, base: "y" }, y: { percent: 100, base: "x" }, self: { percent: 100, base: "self" } }, () => {
        for (const f of ["x", "y", "self"]) {
            const d = rollout.resolveRollout(f, { id: ids[0], env: {}, file: {} });
            assert.equal(d.enabled, false, `${f} in a cycle must be off`);
        }
    });
});

test("deep base chains resolve (C→D shape)", () => {
    withFeatures({ c: { percent: 100 }, d: { percent: 100, base: "c" }, e: { percent: 100, base: "d" } }, () => {
        for (const id of ids.slice(0, 20)) {
            assert.equal(rollout.resolveRollout("e", { id, env: {}, file: {} }).enabled, true);
        }
    });
});

test("rolloutDecisions: sorted, one per registered feature, real install id", () => {
    withFeatures({ zeta: { percent: 0 }, alpha: { percent: 100 } }, () => {
        const ds = rollout.rolloutDecisions(ids[0]);
        assert.deepEqual(ds.map((d) => d.feature), ["alpha", "zeta"]);
        assert.deepEqual(ds.map((d) => d.enabled), [true, false]);
        const sources = ds.map((d): RolloutSource => d.source);
        // percent-0 still flows through the bucketing tier (bucket < 0bp is
        // never true) — "off" is reserved for features with no percent at all.
        assert.deepEqual(sources, ["bucket", "bucket"]);
    });
});

// --- install identity -------------------------------------------------------

test("install id: persisted once, stable across calls, lanes share the file", () => {
    const id1 = rollout.rolloutInstallId();
    const id2 = rollout.rolloutInstallId();
    assert.equal(id1, id2);
    const raw = JSON.parse(readFileSync(path.join(stateRoot, "billion-context", "rollout-id.json"), "utf8"));
    assert.equal(raw.id, id1);
    assert.match(id1, /^[0-9a-f-]{36}$/);
});

test("install id: a pre-existing file wins over regeneration (upgrade keeps the cohort)", () => {
    const pinned = randomUUID();
    const fresh = mkdtempSync(path.join(tmpdir(), "rollout-state2-"));
    const prevHome = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = fresh;
    try {
        mkdirSync(path.join(fresh, "billion-context"), { recursive: true });
        writeFileSync(path.join(fresh, "billion-context", "rollout-id.json"), JSON.stringify({ id: pinned }) + "\n");
        assert.equal(rollout.rolloutInstallId(), pinned);
    } finally {
        process.env.XDG_STATE_HOME = prevHome;
    }
});

test("install id: corrupt file is healed (next calls stable on the healed id)", () => {
    const fresh = mkdtempSync(path.join(tmpdir(), "rollout-state3-"));
    const prevHome = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = fresh;
    try {
        const file = path.join(fresh, "billion-context", "rollout-id.json");
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, "{not json");
        const healed = rollout.rolloutInstallId();
        assert.match(healed, /^[0-9a-f-]{36}$/);
        assert.equal(JSON.parse(readFileSync(file, "utf8")).id, healed);
        assert.equal(rollout.rolloutInstallId(), healed);
    } finally {
        process.env.XDG_STATE_HOME = prevHome;
    }
});

test("install id: unwritable state dir falls back to a stable derived id", () => {
    // A FILE planted where the state DIRECTORY should be makes mkdir fail.
    const blocker = path.join(root, "state-blocker");
    writeFileSync(blocker, "x");
    const prevHome = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = path.join(blocker, "billion-context");
    try {
        const a = rollout.rolloutInstallId();
        const b = rollout.rolloutInstallId();
        assert.equal(a, b);
        assert.ok(a.startsWith("derived-"), `fallback id shape: ${a}`);
    } finally {
        process.env.XDG_STATE_HOME = prevHome;
    }
});

test("install id: config rollout.installId pins the identity", () => {
    const pinned = "support-ticket-pinned-id";
    setConfig({ rollout: { installId: pinned } });
    try {
        assert.equal(rollout.rolloutInstallId(), pinned);
        // and bucketing follows the pin
        withFeatures({ t: { percent: 100 } }, () => {
            assert.equal(rollout.featureEnabled("t"), true);
        });
    } finally {
        setConfig({});
    }
});

test("featureEnabled: wrapper resolves env > world (real id path)", () => {
    withFeatures({ t: { percent: 0 } }, () => {
        setConfig({});
        assert.equal(rollout.featureEnabled("t"), false);
        withEnv({ BILI_ROLLOUT_T: "1" }, () => {
            assert.equal(rollout.featureEnabled("t"), true);
        });
    });
});

test("warnInertRolloutEntries: names features that cannot resolve at all", () => {
    setConfig({ rollout: { features: { typoFeature: { salt: "x" } } } });
    try {
        rollout.warnInertRolloutEntries(); // must not throw; warn path only
    } finally {
        setConfig({});
    }
});

test("cleanup hooks", () => {
    // Restore env for other suites sharing this process (defensive).
    if (previousConfigFile === undefined) delete process.env.BILI_CONFIG_FILE;
    else process.env.BILI_CONFIG_FILE = previousConfigFile;
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    rmSync(root, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
});

process.on("exit", () => {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
});
