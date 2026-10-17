import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfigFile, parseCompressSettings } from "../src/config.ts";
import { setLogCapture } from "../src/logger.ts";
import { rmrf } from "./tmp-rm.ts";

type Captured = { level: string; msg: string };

function captureLogs(): { captured: Captured[]; stop: () => void } {
    const captured: Captured[] = [];
    setLogCapture((level, msg) => captured.push({ level, msg }));
    return { captured, stop: () => setLogCapture(null) };
}

function withConfigFile(body: string, fn: () => void): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-removed-keys-"));
    const file = path.join(dir, "billion-context.json");
    fs.writeFileSync(file, body);
    const prev = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = file;
    try {
        fn();
    } finally {
        if (prev === undefined) delete process.env.BILI_CONFIG_FILE;
        else process.env.BILI_CONFIG_FILE = prev;
        rmrf(dir);
    }
}

// Warnings for the removed-key family only (other INERT emitters exist too).
const familyWarns = (captured: Captured[]) =>
    captured.filter((e) => e.level === "warn" && e.msg.includes("is INERT") && /absorb|imageCompression/.test(e.msg));

test("#3344: removed compress.absorb / compress.imageCompression warn INERT once (root level) and are ignored", () => {
    const { captured, stop } = captureLogs();
    withConfigFile(
        `{"compress":{"absorb":{"enabled":true,"minToolTokens":500},"imageCompression":{"enabled":true,"quality":60}}}`,
        () => {
            const cfg = loadConfigFile();
            // Both keys are gone from the typed surface — the parse whitelist
            // (COMPRESS_SETTING_FIELDS) no longer carries them, so they drop.
            const cs = parseCompressSettings(cfg.compress ?? {});
            assert.equal((cs as Record<string, unknown>).absorb, undefined);
            assert.equal((cs as Record<string, unknown>).imageCompression, undefined);
            const warns = familyWarns(captured);
            assert.equal(warns.length, 1, `expected exactly one family INERT warning, got: ${warns.map((w) => w.msg).join(" | ")}`);
            assert.match(warns[0]!.msg, /compress\.absorb/);
            assert.match(warns[0]!.msg, /compress\.imageCompression/);
            assert.match(warns[0]!.msg, /were removed/);
            // Second load of the SAME content: deduped (one notice per process).
            loadConfigFile();
            assert.equal(familyWarns(captured).length, 1);
        },
    );
    stop();
});

test("#3344: removed keys at provider and model levels are named by full path", () => {
    const { captured, stop } = captureLogs();
    withConfigFile(
        `{"providers":{"https://u.example":{"compress":{"absorb":{"enabled":true}},"models":{"gpt-x":{"compress":{"imageCompression":{"enabled":true}}}}}}}`,
        () => {
            loadConfigFile();
            const warns = familyWarns(captured);
            assert.equal(warns.length, 1, `expected exactly one family INERT warning, got: ${warns.map((w) => w.msg).join(" | ")}`);
            assert.match(warns[0]!.msg, /providers\["https:\/\/u\.example"\]\.compress\.absorb/);
            assert.match(warns[0]!.msg, /providers\["https:\/\/u\.example"\]\.models\["gpt-x"\]\.compress\.imageCompression/);
        },
    );
    stop();
});

test("#3344: configs without the removed keys stay silent", () => {
    const { captured, stop } = captureLogs();
    withConfigFile(`{"compress":{"ccr":{"enabled":true}}}`, () => {
        loadConfigFile();
        assert.equal(familyWarns(captured).length, 0);
    });
    stop();
});
