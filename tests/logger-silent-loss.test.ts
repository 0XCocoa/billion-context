import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    configureLogger,
    log,
    closeLogger,
    setLogCapture,
    muteStderrLeg,
    isFileLoggingActive,
    onFileLegLive,
} from "../src/logger.ts";
import { rmrf } from "./tmp-rm.ts";

/**
 * #3857: a log file whose OPEN is refused by the OS (ASYNChronous failure —
 * EPERM/EACCES on a locked or sandboxed path) must not lose every line with
 * zero trace: one [warn] per degradation episode, and the muted stderr
 * fallback (#2864) must come back so a launcher-spawned child keeps durable
 * output in its %TEMP% port log. A DIRECTORY as the log path makes open(2)
 * fail asynchronously on every platform (EISDIR/EPERM), deterministically.
 */

function captureStderr(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const orig = process.stderr;
    Object.defineProperty(process, "stderr", {
        configurable: true,
        value: { write: (chunk: unknown) => { lines.push(String(chunk)); return true; } },
    });
    return { lines, restore: () => Object.defineProperty(process, "stderr", { configurable: true, value: orig }) };
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 20));
    }
}

test("#3857: async open failure warns once and restores the muted stderr fallback", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-logger-silent-"));
    fs.mkdirSync(path.join(dir, "bili.log")); // a DIRECTORY: open(2) fails async
    const cap = captureStderr();
    const warns: string[] = [];
    setLogCapture((level, msg) => { if (level === "warn") warns.push(msg); });
    configureLogger(path.join(dir, "bili.log"));
    try {
        muteStderrLeg(); // worst case: #2864 mute already fired on pending state
        log("info", "early-line"); // pre-failure + muted — legitimately may vanish
        await waitFor(() => warns.length >= 1, "degradation warn");
        assert.ok(warns[0].includes("unavailable"), `warn names the failure (got: ${warns[0]})`);
        assert.ok(warns[0].includes("stderr-only"), "warn states the fallback mode");
        assert.equal(isFileLoggingActive(), false, "a never-opened stream is not 'active'");
        log("info", "late-line");
        await waitFor(() => cap.lines.some((l) => l.includes("late-line")), "late-line on restored stderr");
        assert.ok(cap.lines.some((l) => l.includes("unavailable")), "the warn itself reached the restored stderr leg");
        log("info", "third-line");
        await new Promise((r) => setTimeout(r, 50));
        assert.equal(warns.filter((w) => w.includes("unavailable")).length, 1, "one [warn] per degradation episode");
        assert.ok(cap.lines.some((l) => l.includes("third-line")), "fallback keeps carrying lines");
    } finally {
        setLogCapture(null);
        cap.restore();
        closeLogger();
        rmrf(dir);
    }
});

test("#3857: onFileLegLive fires exactly once, only after a proven open", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-logger-silent-"));
    const file = path.join(dir, "bili.log");
    let fires = 0;
    onFileLegLive(() => { fires++; });
    configureLogger(file);
    try {
        assert.equal(fires, 0, "must not fire while the first open is still in flight");
        await waitFor(() => isFileLoggingActive(), "proven file-leg open");
        assert.equal(fires, 1, "fires once when the fd is established");
        log("info", "tick");
        await new Promise((r) => setTimeout(r, 50));
        assert.equal(fires, 1, "does not re-fire per write");
    } finally {
        onFileLegLive(null);
        closeLogger();
        rmrf(dir);
    }
});

test("#3857: onFileLegLive never fires when the open fails", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-logger-silent-"));
    fs.mkdirSync(path.join(dir, "bili.log")); // a DIRECTORY: open(2) fails async
    let fires = 0;
    onFileLegLive(() => { fires++; });
    const cap = captureStderr();
    const warns: string[] = [];
    setLogCapture((level, msg) => { if (level === "warn") warns.push(msg); });
    configureLogger(path.join(dir, "bili.log"));
    try {
        log("info", "probe");
        await waitFor(() => warns.length >= 1, "degradation warn");
        await new Promise((r) => setTimeout(r, 50));
        assert.equal(fires, 0, "no live-hook callback for a failed open");
    } finally {
        onFileLegLive(null);
        setLogCapture(null);
        cap.restore();
        closeLogger();
        rmrf(dir);
    }
});

test("#3857: late registration observes an already-open stream immediately", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-logger-silent-"));
    const file = path.join(dir, "bili.log");
    configureLogger(file);
    try {
        await waitFor(() => isFileLoggingActive(), "proven file-leg open");
        let fires = 0;
        onFileLegLive(() => { fires++; });
        assert.equal(fires, 1, "registration while open fires immediately");
        onFileLegLive(null);
    } finally {
        closeLogger();
        rmrf(dir);
    }
});
