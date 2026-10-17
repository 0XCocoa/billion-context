// #3544: a profile upgrade left the OLD detached proxy holding the canonical
// port forever — app exit cannot kill it (the watchdog's kill(pid,0) liveness
// check is identity-blind to Windows pid recycling), and BOTH attach paths
// (discovery AND pinned) re-attached healthy-but-stale residents without
// comparing generations ⇒ "can never update". This suite pins the three new
// mechanisms: (1) discovery bring-up rotates a strictly-older same-lane
// resident holding our canonical port (supervised drain+exit, then spawn onto
// the freed port); (2) owner heartbeat + heartbeat-expiry watchdog channel
// (watcherIsDead); (3) the admin POST /__bili/shutdown route + the pinned-
// attach rotation twin (rotatePinnedStaleProxy).

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ProxyInstanceFile } from "../src/instance.ts";
import { VERSION } from "../src/version.ts";
import {
    ensureProxyRunning,
    startOwnerHeartbeat,
    type SpawnChild,
    type SpawnFn,
} from "../src/launcher.ts";
import { watcherIsDead } from "../src/server.ts";
import { handleAdminRoute } from "../src/server/admin.ts";
import { BILI_TUNNEL_HEADER } from "../src/tunnel-guard.ts";
import { rotatePinnedStaleProxy } from "../src/agent/dsh-native.ts";

const ORIGIN = "http://127.0.0.1:18787";
const CHILD_PID = 42_471;

const FP_SCRIPT = path.join(os.tmpdir(), `bili-fp-3544-${process.pid}.js`);
fs.writeFileSync(FP_SCRIPT, "// fingerprint fixture\n");
const FP_HASH = createHash("sha256").update(fs.readFileSync(FP_SCRIPT)).digest("hex");

function staleInstance(port = 18787, userZone = false): ProxyInstanceFile {
    const inst: ProxyInstanceFile = {
        origin: `http://127.0.0.1:${port}`,
        instanceId: "old-instance",
        // process.pid: ALIVE, so the candidate survives the probe-time
        // isPidAlive drop and reaches the rotation decision.
        pid: process.pid,
        startedAt: Date.now(),
        host: "127.0.0.1",
        port,
        passthrough: false,
        mitmDomains: [],
        modelWindows: {},
        codeFingerprint: "old-build",
    };
    if (!userZone) {
        inst.lane = "dsh";
        inst.launchToken = "old-token";
    }
    return inst;
}

function mineMarker(): ProxyInstanceFile {
    return {
        origin: ORIGIN,
        instanceId: "mine-1",
        pid: CHILD_PID,
        startedAt: Date.now(),
        host: "127.0.0.1",
        port: 18787,
        passthrough: false,
        mitmDomains: [],
        modelWindows: {},
        lane: "dsh",
        codeFingerprint: FP_HASH,
    };
}

function makeFakeChild(pid: number): SpawnChild {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    return {
        pid,
        unref(): void {},
        kill(): boolean { return true; },
        on(event: string, listener: (...args: unknown[]) => void): SpawnChild {
            const list = listeners.get(event) ?? [];
            list.push(listener);
            listeners.set(event, list);
            return this;
        },
    } as SpawnChild;
}

function fakeClock() {
    let ticks = 0;
    return {
        now: (): number => ticks * 1000,
        sleep: (): Promise<void> => { ticks += 1; return Promise.resolve(); },
        ticks: (): number => ticks,
    };
}

interface BringUpCase {
    healthVersion?: string;
    armed?: boolean;
    refuseShutdown?: boolean;
    userZone?: boolean;
    stalePort?: number;
}

async function runBringUp(t: BringUpCase) {
    const clock = fakeClock();
    const shutdownCalls: string[] = [];
    let spawnCalls = 0;
    let staleDead = false;
    const stalePort = t.stalePort ?? 18787;
    const staleOrigin = `http://127.0.0.1:${stalePort}`;
    const spawnImpl: SpawnFn = () => {
        spawnCalls += 1;
        return makeFakeChild(CHILD_PID);
    };
    const handle = await ensureProxyRunning(
        // parentPid ≠ process.pid ⇒ owner heartbeat stays inert in these units.
        { host: "127.0.0.1", port: 18787, passthrough: false, debug: false, lane: "dsh", parentPid: 999_999 },
        {
            fetchImpl: async (url) => ({ ok: url.startsWith(ORIGIN) }),
            fetchHealthInfo: async (origin) => {
                if (origin !== staleOrigin || staleDead) return { ok: false };
                const info: { ok: boolean; instanceId: string; pid: number; watchdog: { armed: boolean }; version?: string } = {
                    ok: true,
                    instanceId: "old-instance",
                    pid: process.pid,
                    watchdog: { armed: t.armed ?? true },
                };
                if (t.healthVersion !== undefined) info.version = t.healthVersion;
                return info;
            },
            spawnImpl,
            now: clock.now,
            sleep: clock.sleep,
            // probeLiveInstances sources candidates from the instance FILE view
            // plus the real registry (not injectable), so the resident must be
            // visible through the file to reach the rotation decision.
            readInstanceFile: (): ProxyInstanceFile => staleInstance(stalePort, t.userZone ?? false),
            listRegistryInstances: (): ProxyInstanceFile[] => [staleInstance(stalePort, t.userZone ?? false), mineMarker()],
            requestInstanceShutdown: async (origin) => {
                shutdownCalls.push(origin);
                if (t.refuseShutdown) return false;
                staleDead = true;
                return true;
            },
        },
    );
    return { shutdownCalls, spawnCalls, handle, clock };
}

test("#3544 discovery bring-up rotates a strictly-older same-lane resident off our canonical port", async () => {
    const r = await runBringUp({ healthVersion: "0.0.1" });
    assert.deepEqual(r.shutdownCalls, [ORIGIN], "asked the old resident for a graceful shutdown");
    assert.equal(r.spawnCalls, 1, "spawned the current build afterwards");
    assert.equal(r.handle.origin, ORIGIN);
    assert.equal(r.handle.port, 18787, "bound the freed canonical port, not a ladder drift");
    assert.ok(r.handle.child, "returned a spawned child handle");
    assert.ok(r.clock.ticks() <= 2, `drain-wait was bounded (ticks=${r.clock.ticks()})`);
});

test("#3544 equal-version resident is never rotated (no churn on equal builds)", async () => {
    const r = await runBringUp({ healthVersion: VERSION });
    assert.equal(r.shutdownCalls.length, 0);
    assert.equal(r.spawnCalls, 1);
    assert.equal(r.handle.port, 18787);
});

test("#3544 user-zone daemons are never touched by rotation", async () => {
    const r = await runBringUp({ healthVersion: "0.0.1", userZone: true });
    assert.equal(r.shutdownCalls.length, 0);
    assert.equal(r.spawnCalls, 1);
});

test("#3544 unarmed-watchdog residents are never rotated", async () => {
    const r = await runBringUp({ healthVersion: "0.0.1", armed: false });
    assert.equal(r.shutdownCalls.length, 0);
    assert.equal(r.spawnCalls, 1);
});

test("#3544 refused shutdown falls back to plain spawn immediately (no poll loop)", async () => {
    const r = await runBringUp({ healthVersion: "0.0.1", refuseShutdown: true });
    assert.deepEqual(r.shutdownCalls, [ORIGIN]);
    assert.equal(r.spawnCalls, 1);
    assert.ok(r.clock.ticks() <= 1, `no drain-wait after refusal (ticks=${r.clock.ticks()})`);
});

test("#3544 stale resident on a non-canonical port is left alone", async () => {
    const r = await runBringUp({ healthVersion: "0.0.1", stalePort: 18799 });
    assert.equal(r.shutdownCalls.length, 0);
    assert.equal(r.spawnCalls, 1);
    assert.equal(r.handle.port, 18787);
});

test("#3544 pre-#3544 residents (health without version) keep today's coexist behavior", async () => {
    const r = await runBringUp({});
    assert.equal(r.shutdownCalls.length, 0);
    assert.equal(r.spawnCalls, 1);
});

test("#3544 owner heartbeat re-asserts liveness (hb:true) until stopped", async () => {
    const posts: string[] = [];
    const post = async (body: string): Promise<void> => { posts.push(body); };
    const stop = startOwnerHeartbeat("http://127.0.0.1:1", process.pid, 5, post);
    assert.equal(typeof stop, "function");
    await new Promise((resolve) => setTimeout(resolve, 40));
    stop!();
    assert.ok(posts.length >= 1, `at least one beat (got ${posts.length})`);
    assert.deepEqual(JSON.parse(posts[0]), { pid: process.pid, hb: true });
    const frozen = posts.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(posts.length, frozen, "no beats after stop()");
});

test("#3544 owner heartbeat refuses foreign pids (claude-lane ppid keeps legacy kill-0)", () => {
    const posts: string[] = [];
    const stop = startOwnerHeartbeat("http://127.0.0.1:1", 999_999, 5, async (body: string) => { posts.push(body); });
    assert.equal(stop, undefined);
    assert.equal(posts.length, 0);
});

test("#3544 pinned rotation: refused shutdown ⇒ false, exactly one request, no polling", async () => {
    const original = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (input: unknown): Promise<Response> => {
        urls.push(String(input));
        return { ok: false } as Response;
    }) as typeof fetch;
    try {
        assert.equal(await rotatePinnedStaleProxy(ORIGIN), false);
        assert.deepEqual(urls, [`${ORIGIN}/__bili/shutdown`]);
    } finally {
        globalThis.fetch = original;
    }
});

test("#3544 pinned rotation: accepted shutdown + dead target ⇒ true", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: unknown): Promise<Response> => {
        const u = String(input);
        if (u.endsWith("/__bili/shutdown")) return { ok: true } as Response;
        throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    try {
        assert.equal(await rotatePinnedStaleProxy(ORIGIN), true);
    } finally {
        globalThis.fetch = original;
    }
});

type AdminCtxForTest = Parameters<typeof handleAdminRoute>[2];

function makeCtx(requestShutdown: (reason: string) => void): AdminCtxForTest {
    return {
        opts: { host: "127.0.0.1" },
        core: {},
        config: {},
        log: (): void => {},
        instanceId: "test-instance",
        instanceStartedAt: Date.now(),
        proxyWatchers: new Set<number>(),
        initialWatcherPid: null,
        bootReady: (): boolean => true,
        requestShutdown,
    } as unknown as AdminCtxForTest;
}

function mkReq(remoteAddress: string, extraHeaders: Record<string, string> = {}): http.IncomingMessage {
    // the trusted-origin gate verifies the Host header against the admin's
    // trusted hostnames, so bare loopback requests must carry it
    const headers = { host: "127.0.0.1", ...extraHeaders };
    return Object.assign(new Readable({ read(): void {} }), {
        method: "POST",
        url: "/__bili/shutdown",
        headers,
        socket: { remoteAddress },
    }) as unknown as http.IncomingMessage;
}

function mkRes(): { res: http.ServerResponse; out: { code?: number; body?: string } } {
    const out: { code?: number; body?: string } = {};
    const res = {
        writeHead(code: number, _headers?: unknown): void { out.code = code; },
        end(body?: string): void { out.body = body; },
    };
    return { res: res as unknown as http.ServerResponse, out };
}

test("#3544 POST /__bili/shutdown (loopback) triggers the graceful-shutdown hook", async () => {
    const reasons: string[] = [];
    const { res, out } = mkRes();
    await handleAdminRoute(mkReq("127.0.0.1"), res, makeCtx((r) => reasons.push(r)));
    assert.equal(out.code, 202);
    assert.deepEqual(JSON.parse(out.body ?? "{}"), { ok: true });
    assert.equal(reasons.length, 1);
    assert.ok(reasons[0].includes("#3544"), `reason carries provenance (${reasons[0]})`);
});

test("#3544 POST /__bili/shutdown refuses non-loopback peers", async () => {
    const reasons: string[] = [];
    const { res, out } = mkRes();
    await handleAdminRoute(mkReq("10.0.0.5"), res, makeCtx((r) => reasons.push(r)));
    assert.equal(out.code, 403);
    assert.equal(reasons.length, 0);
});

test("#3544 POST /__bili/shutdown refuses tunneled requests even from loopback", async () => {
    const reasons: string[] = [];
    const { res, out } = mkRes();
    await handleAdminRoute(mkReq("127.0.0.1", { [BILI_TUNNEL_HEADER]: "1" }), res, makeCtx((r) => reasons.push(r)));
    assert.equal(out.code, 403);
    assert.equal(reasons.length, 0);
});

test("#3544 watcherIsDead: legacy registrations keep kill-0-only semantics", () => {
    const now = Date.now();
    assert.equal(watcherIsDead(true, undefined, now, 15_000), false, "alive + never heartbeated stays alive");
    assert.equal(watcherIsDead(false, undefined, now, 15_000), true, "dead pid is dead regardless of heartbeat");
});

test("#3544 watcherIsDead: heartbeat-opted pids age out past the grace window", () => {
    const now = Date.now();
    assert.equal(watcherIsDead(true, now - 1_000, now, 15_000), false, "fresh heartbeat keeps a recycled pid alive");
    assert.equal(watcherIsDead(true, now - 16_000, now, 15_000), true, "missed beats beyond grace mark the slot dead");
    assert.equal(watcherIsDead(false, now - 1_000, now, 15_000), true, "a truly dead pid never needs the heartbeat");
});
