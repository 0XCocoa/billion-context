import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { findVerifiedSameLaneTwin, type InstanceShape, type RegistryEntry } from "../src/instance.ts";

const ROOT = path.join(import.meta.dirname, "..");
const ENTRY = path.join(ROOT, "src/index.ts");
const BASE = 18841;
const OWN_FP = "fp-our-build";

function ownShape(over: Partial<InstanceShape> = {}): InstanceShape {
    return {
        host: "127.0.0.1",
        passthrough: false,
        mitmDomains: [],
        modelWindows: {},
        modelMaxOutputs: {},
        ...over,
    };
}

function holder(over: Partial<RegistryEntry> = {}): RegistryEntry {
    return {
        instanceId: "holder-4341",
        pid: process.pid,
        port: BASE,
        origin: `http://127.0.0.1:${BASE}`,
        startedAt: Date.now(),
        host: "127.0.0.1",
        passthrough: false,
        mitmDomains: [],
        modelWindows: {},
        modelMaxOutputs: {},
        lane: "pi",
        codeFingerprint: OWN_FP,
        ...over,
    };
}

function sameShape(own: InstanceShape): (entry: RegistryEntry) => boolean {
    return (entry) =>
        entry.host === own.host &&
        Boolean(entry.passthrough) === own.passthrough &&
        JSON.stringify(entry.mitmDomains ?? []) === JSON.stringify(own.mitmDomains) &&
        JSON.stringify(entry.modelWindows ?? {}) === JSON.stringify(own.modelWindows) &&
        JSON.stringify(entry.modelMaxOutputs ?? {}) === JSON.stringify(own.modelMaxOutputs);
}

test("verified twin: matching health identity permits the early adopt", async () => {
    const entry = holder();
    const peer = await findVerifiedSameLaneTwin([entry], BASE, "pi", OWN_FP, sameShape(ownShape()), async (origin) => {
        assert.equal(origin, entry.origin);
        return { pid: entry.pid, instanceId: entry.instanceId };
    });
    assert.equal(peer?.instanceId, entry.instanceId);
});

test("verified twin: stale matching marker cannot hide a later verified twin", async () => {
    const stale = holder({ instanceId: "stale-4341" });
    const live = holder({ instanceId: "live-4341" });
    const peer = await findVerifiedSameLaneTwin([stale, live], BASE, "pi", OWN_FP, sameShape(ownShape()), async () => ({
        pid: live.pid,
        instanceId: live.instanceId,
    }));
    assert.equal(peer?.instanceId, live.instanceId);
});

test("verified twin: stale marker or foreign listener cannot trigger the early adopt", async () => {
    const entry = holder();
    assert.equal(
        await findVerifiedSameLaneTwin([entry], BASE, "pi", OWN_FP, sameShape(ownShape()), async () => ({ pid: entry.pid + 1, instanceId: entry.instanceId })),
        undefined,
        "pid mismatch",
    );
    assert.equal(
        await findVerifiedSameLaneTwin([entry], BASE, "pi", OWN_FP, sameShape(ownShape()), async () => ({ pid: entry.pid, instanceId: "replacement" })),
        undefined,
        "instance mismatch",
    );
    assert.equal(
        await findVerifiedSameLaneTwin([entry], BASE, "pi", OWN_FP, sameShape(ownShape()), async () => undefined),
        undefined,
        "no health proof",
    );
});

test("verified twin: config drift preserves the existing bind/EADDRINUSE path", async () => {
    let healthCalls = 0;
    const peer = await findVerifiedSameLaneTwin(
        [holder({ modelWindows: { "model-a": 1000 } })],
        BASE,
        "pi",
        OWN_FP,
        sameShape(ownShape()),
        async () => {
            healthCalls += 1;
            return { pid: process.pid, instanceId: "holder-4341" };
        },
    );
    assert.equal(peer, undefined);
    assert.equal(healthCalls, 0, "a drifted peer is not an adopt candidate and must not be health-probed");
});

test("real CLI: verified twin exits before unified SQLite initialization", { timeout: 30_000 }, async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4341-"));
    const stateHome = path.join(sandbox, "state");
    const dataHome = path.join(sandbox, "data");
    const configHome = path.join(sandbox, "config");
    const cacheHome = path.join(sandbox, "cache");
    const sessions = path.join(dataHome, "sessions");
    const instanceId = "live-twin-4341";
    const server = http.createServer((req, res) => {
        if (req.url === "/__bili/health") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, pid: process.pid, instanceId }));
            return;
        }
        res.writeHead(404).end();
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    const registryDir = path.join(stateHome, "billion-context", "instances");
    fs.mkdirSync(registryDir, { recursive: true });
    const fingerprint = createHash("sha256").update(fs.readFileSync(ENTRY)).digest("hex");
    fs.writeFileSync(
        path.join(registryDir, `${instanceId}.json`),
        JSON.stringify({
            instanceId,
            pid: process.pid,
            port,
            origin: `http://127.0.0.1:${port}`,
            startedAt: Date.now(),
            host: "127.0.0.1",
            passthrough: false,
            mitmDomains: [],
            modelWindows: {},
            modelMaxOutputs: {},
            lane: "pi",
            codeFingerprint: fingerprint,
        }) + "\n",
    );

    const env: NodeJS.ProcessEnv = {
        ...process.env,
        NODE_ENV: "test",
        HOME: sandbox,
        XDG_STATE_HOME: stateHome,
        XDG_DATA_HOME: dataHome,
        XDG_CONFIG_HOME: configHome,
        XDG_CACHE_HOME: cacheHome,
        BILI_SESSIONS_DIR: sessions,
        BILI_LAUNCH_TOKEN: "issue-4341-test",
        BILI_LAUNCHER_LANE: "pi",
        BILI_PARENT_PID: String(process.pid),
        BILI_STORAGE_UNIFIED: "full",
        BILI_MITM: "0",
        ACP_PASSTHROUGH: "0",
        BILI_LAUNCHER_MODEL_WINDOWS: "{}",
        BILI_LAUNCHER_MODEL_MAX_OUTPUTS: "{}",
    };
    delete env.NODE_TEST_CONTEXT;
    delete env.BILI_ENCRYPTION_KEY;

    try {
        const child = spawn(process.execPath, ["--import", "tsx", ENTRY, "start", "--host", "127.0.0.1", "--port", String(port)], {
            cwd: ROOT,
            env,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => { output += chunk; });
        child.stderr.on("data", (chunk: string) => { output += chunk; });
        const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
        const code = await new Promise<number | null>((resolve, reject) => {
            child.once("error", reject);
            child.once("exit", resolve);
        });
        clearTimeout(timer);

        assert.equal(code, 3, output);
        assert.match(output, /exiting before persistence initialization/);
        assert.equal(fs.existsSync(path.join(sessions, "index.db")), false, "the duplicate must not create/open the unified database");
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        fs.rmSync(sandbox, { recursive: true, force: true });
    }
});
