// Unverified-dsh-build boot note: soft warning for dsh client builds that are
// not on the verified list (CI e2e anchor 0.2.0-rc.2). Covers the version
// resolver (walk-up over node_modules), the verified-list knob
// (BILI_DSH_VERIFIED_VERSIONS), and the message composer's decision table.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dshClientVersionFrom, verifiedDshVersions, unverifiedDshBuildMessage } from "../src/agent/dsh-native.ts";

function fixtureRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dshver-"));
    fs.mkdirSync(path.join(root, "node_modules", "@deepseek-ai", "dsh"), { recursive: true });
    fs.writeFileSync(
        path.join(root, "node_modules", "@deepseek-ai", "dsh", "package.json"),
        JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.2.1-rc.2" }),
        "utf8",
    );
    return root;
}

test("dshClientVersionFrom walks up to the nearest node_modules/@deepseek-ai/dsh", () => {
    const root = fixtureRoot();
    try {
        const deep = path.join(root, "nested", "deeper");
        fs.mkdirSync(deep, { recursive: true });
        assert.equal(dshClientVersionFrom(deep), "0.2.1-rc.2");
        // also found when starting AT the node_modules root level
        assert.equal(dshClientVersionFrom(root), "0.2.1-rc.2");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("dshClientVersionFrom returns undefined when no client package sits above", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dshver-empty-"));
    try {
        const deep = path.join(empty, "a", "b");
        fs.mkdirSync(deep, { recursive: true });
        // this machine's tmp tree carries no node_modules/@deepseek-ai/dsh
        assert.equal(dshClientVersionFrom(deep), undefined);
    } finally {
        fs.rmSync(empty, { recursive: true, force: true });
    }
});

test("verifiedDshVersions honors BILI_DSH_VERIFIED_VERSIONS (list / override / off)", () => {
    const KEY = "BILI_DSH_VERIFIED_VERSIONS";
    const prev = process.env[KEY];
    try {
        delete process.env[KEY];
        const def = verifiedDshVersions();
        assert.ok(def !== undefined && def.has("0.2.0-rc.2"), "default list covers the CI e2e anchor");

        process.env[KEY] = "9.9.9, 8.8.8";
        const ov = verifiedDshVersions();
        assert.deepEqual([...(ov ?? [])].sort(), ["8.8.8", "9.9.9"], "explicit list replaces the default");

        process.env[KEY] = "";
        assert.equal(verifiedDshVersions(), undefined, "empty string turns the check OFF");
        process.env[KEY] = ",,";
        assert.equal(verifiedDshVersions(), undefined, "whitespace-only list also means OFF");
    } finally {
        if (prev === undefined) delete process.env[KEY];
        else process.env[KEY] = prev;
    }
});

test("unverifiedDshBuildMessage decision table (bilingual text)", () => {
    delete process.env.BILI_DSH_VERIFIED_VERSIONS;
    // verified-by-default build: silent
    assert.equal(unverifiedDshBuildMessage("0.2.0-rc.2", {}), null);
    // nothing resolved: absence of evidence is not a broken build — silent
    assert.equal(unverifiedDshBuildMessage(undefined, {}), null);
    // unverified build under defaults: EN + CN guidance
    const msg = unverifiedDshBuildMessage("0.2.1-rc.2", {});
    assert.ok(msg !== null, "unverified build produces a message");
    assert.ok(msg!.includes("v0.2.1-rc.2"), "names the detected build");
    assert.ok(msg!.includes("0.2.0-rc.2"), "names the verified baseline");
    assert.ok(msg!.includes("压缩功能在该版本上可能不稳定"), "carries the Chinese half");
    // ops can extend the list (comma, whitespace tolerated) or switch off
    assert.equal(unverifiedDshBuildMessage("9.9.9", { BILI_DSH_VERIFIED_VERSIONS: " 9.9.9 , 8.8.8" }), null);
    const extended = unverifiedDshBuildMessage("7.7.7", { BILI_DSH_VERIFIED_VERSIONS: "9.9.9,8.8.8" });
    assert.ok(extended !== null && extended.includes("9.9.9 / 8.8.8"), "custom list names its members");
    assert.equal(unverifiedDshBuildMessage("9.9.9", { BILI_DSH_VERIFIED_VERSIONS: "" }), null, "check-off silences");
});
