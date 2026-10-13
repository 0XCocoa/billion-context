import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { setLogCapture, closeLogger } from "../src/logger.ts";
import { rmrf } from "./tmp-rm.ts";

// #2864①: the startup banner must self-identify its writer — pid plus the
// instance id (the same token the instance registry prints) — so that N
// banners on one port are attributable to N distinct short-lived processes
// instead of 24 indistinguishable duplicates.

interface Captured { level: string; msg: string }

async function startBare(opts: Partial<ProxyOptions>, captured: Captured[]): Promise<{ proxy: http.Server; dir: string }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-banner-"));
    setLogCapture((level, msg) => captured.push({ level, msg }));
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const base: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: {},
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: false, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: true,
        debug: false,
        passthrough: false,
        passthroughSource: null,
        chainContentDetection: false,
        autoUpdate: false,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: true,
        releaseNotesCheck: true,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        mitm: { enabled: false, domains: [] },
        logFile: path.join(dir, "bili.log"),
        ...opts,
    };
    const proxy = await startServer(base);
    await once(proxy, "listening");
    return { proxy, dir };
}

test("banner carries pid + instance id and fires exactly once per listen", async () => {
    const captured: Captured[] = [];
    let dir: string | undefined;
    try {
        const { proxy, dir: d } = await startBare({}, captured);
        dir = d;
        const port = (proxy.address() as { port: number }).port;
        const banners = captured.filter((c) => c.msg.includes("listening on"));
        assert.equal(banners.length, 1, "one banner per successful listen");
        assert.match(banners[0]!.msg, new RegExp(`^acp-proxy v[\\d.]+ \\(pid ${process.pid}, id [0-9a-f]{8}\\) listening on http://127\\.0\\.0\\.1:${port}`));
        assert.ok(banners[0]!.msg.includes("web UI:"), "rest of the banner line is unchanged");
        await new Promise<void>((resolve, reject) => proxy.close((e) => (e ? reject(e) : resolve())));
    } finally {
        setLogCapture(null);
        closeLogger();
        if (dir) rmrf(dir);
    }
});
