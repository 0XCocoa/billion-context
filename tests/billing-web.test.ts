import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST_ZSTD = "0";
// Hermetic config + legacy storage baseline (same discipline as
// tests/issue3199-overview-cold-scan.test.ts): a developer machine's real
// billion-context.json and unified store must not leak into these rows.
process.env.BILI_CONFIG_FILE = path.join(
    mkdtempSync(path.join(tmpdir(), "bili-billing-web-")),
    "no-config.json",
);
process.env.BILI_STORAGE_UNIFIED = "legacy";
process.env.XDG_STATE_HOME = `${import.meta.dirname ?? "."}/.billing-web-state-${process.pid}`;
// Isolate the disk index from the real machine corpus (same discipline as
// tests/issue3199-overview-cold-scan.test.ts): buildOverview walks the
// sessions dir when no index row exists, and this suite asserts exact USD
// totals — a real session with priced folds would break them.
process.env.BILI_SESSIONS_DIR = mkdtempSync(path.join(tmpdir(), "bili-billing-web-sessions-"));

import { handleConfigPut, handlePricingGet } from "../src/web/api.js";
import { buildOverview, buildSessionList, _resetDiskCacheForTest } from "../src/web/sessions-data.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetSessionsForTest, getSession } from "../src/session.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { loadOptions } from "../src/config.ts";
import { resolveBillingPrice, setBillingOverrides } from "../src/billing.ts";
import { rmrf } from "./tmp-rm.ts";

function resetState(): void {
    setRegistryForTest({}, { "somehost/claude-bill": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } });
    setBillingOverrides(undefined);
    _resetSessionsForTest();
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetDiskCacheForTest();
}

function seedSession(id: string, model: string | undefined): void {
    const s = getSession(id, { protocol: "anthropic", upstreamOrigin: "http://api.somehost.com" });
    if (model) s.metadata.lastModel = model;
    s.stats.requests = 2; // survive isEmptyStub (requests<=1 && no ctx/blocks/ledger gets hidden)
}

async function getPricing(): Promise<{ status: number; payload: Record<string, unknown> }> {
    let status = 0;
    let payloadText = "";
    const res = {
        writeHead(s: number) { status = s; return this; },
        end(b?: string | Buffer) { payloadText = typeof b === "string" ? b : String(b ?? ""); },
    };
    await handlePricingGet(res as unknown as ServerResponse);
    return { status, payload: JSON.parse(payloadText) as Record<string, unknown> };
}

async function putConfig(body: unknown): Promise<{ status: number; payload: Record<string, unknown> }> {
    const req = new Readable({ read() {} });
    req.push(Buffer.from(JSON.stringify(body)));
    req.push(null);
    let status = 0;
    let payloadText = "";
    const res = {
        writeHead(s: number) { status = s; return this; },
        end(b?: string | Buffer) { payloadText = typeof b === "string" ? b : String(b ?? ""); },
    };
    await handleConfigPut(req as unknown as IncomingMessage, res as unknown as ServerResponse, () => loadOptions(), 8787);
    return { status, payload: JSON.parse(payloadText) as Record<string, unknown> };
}

function withRawConfig(t: test.TestContext, rawText: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-billing-web-cfg-"));
    const p = path.join(dir, "billion-context.json");
    writeFileSync(p, rawText, "utf8");
    const prev = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = p;
    t.after(() => {
        process.env.BILI_CONFIG_FILE = prev ?? "";
        rmrf(dir);
    });
    return p;
}

test("#4899 pricing GET: lists session models with resolved prices, marks overrides, keeps orphan override keys editable", async () => {
    resetState();
    seedSession("web-bill-1", "claude-bill");
    seedSession("web-bill-2", "claude-unknown");
    setBillingOverrides({ "anthropic/gone-model": { input: 9 } });

    const { status, payload } = await getPricing();
    assert.equal(status, 200);
    const models = payload.models as Array<Record<string, unknown>>;
    const byModel = new Map(models.map((m) => [String(m.model), m]));

    const known = byModel.get("claude-bill");
    assert.ok(known, "session model listed");
    assert.equal((known!.price as Record<string, unknown>).input, 3, "registry row resolved (cross-host suffix scan)");
    assert.equal(known!.override, undefined, "no override for this model");
    assert.equal(known!.host, "api.somehost.com", "origin host carried for host-aware matching");

    const unknown = byModel.get("claude-unknown");
    assert.ok(unknown, "unpriced session model listed");
    assert.equal(unknown!.price, null, "no price anywhere: null, the UI shows tokens only");

    const orphan = byModel.get("anthropic/gone-model");
    assert.ok(orphan, "override key with no recent session stays listed/editable");
    assert.ok((orphan!.override as Record<string, unknown>).input === 9, "its override entry is exposed");
    assert.notEqual((payload.overrides as Record<string, unknown>)["anthropic/gone-model"], undefined, "raw override table echoed");
});

test("#4899 pricing PUT: writes billing.prices, hot-applies overrides, empty map deletes the block", async (t) => {
    resetState();
    withRawConfig(t, "{\n  \"upstreamProxy\": \"http://127.0.0.1:9999\",\n}\n");

    const put = await putConfig({ billing: { prices: { "anthropic/claude-bill": { input: 6, output: 30, cacheRead: 0.6 } } } });
    assert.equal(put.status, 200, `save accepted (${JSON.stringify(put.payload)})`);
    const saved = JSON.parse(readFileSync(process.env.BILI_CONFIG_FILE!, "utf8")) as Record<string, unknown>;
    assert.deepEqual(
        saved.billing,
        { prices: { "anthropic/claude-bill": { input: 6, output: 30, cacheRead: 0.6 } } },
        "block persisted into the config file, other keys preserved",
    );
    // onChanged → loadOptions → setBillingOverrides: hot-applied without restart.
    const resolved = resolveBillingPrice("claude-bill");
    assert.ok(resolved);
    assert.equal(resolved.source, "config");
    assert.equal(resolved.input, 6, "override outranks the registry row");
    assert.equal(resolved.cacheWrite, 6, "missing cacheWrite falls back to the override's input rate");

    // Saving an empty prices map deletes the block (registry defaults take over).
    const put2 = await putConfig({ billing: { prices: {} } });
    assert.equal(put2.status, 200);
    const saved2 = JSON.parse(readFileSync(process.env.BILI_CONFIG_FILE!, "utf8")) as Record<string, unknown>;
    assert.equal(saved2.billing, undefined, "empty prices map removes the block");
    assert.equal(resolveBillingPrice("claude-bill")?.source, "registry", "registry row back in charge");
});

test("#4899 pricing PUT: invalid shapes are rejected loudly (400), never silently dropped", async (t) => {
    resetState();
    withRawConfig(t, "{}\n");
    const bad = await putConfig({ billing: { prices: { m: { input: -1 } } } });
    assert.equal(bad.status, 400);
    const bad2 = await putConfig({ billing: { prices: { m: { input: 3, typo: 1 } } } });
    assert.equal(bad2.status, 400);
    const bad3 = await putConfig({ billing: { prices: "x" } });
    assert.equal(bad3.status, 400);
    const saved = JSON.parse(readFileSync(process.env.BILI_CONFIG_FILE!, "utf8")) as Record<string, unknown>;
    assert.equal(saved.billing, undefined, "nothing written on rejection");
});

test("#4899 pricing PUT: a broken config file still blocks every structured save (409 guard intact)", async (t) => {
    resetState();
    withRawConfig(t, "{ not json\n");
    const put = await putConfig({ billing: { prices: { m: { input: 1 } } } });
    assert.equal(put.status, 409, "guard fires before any merge, #3572 discipline preserved");
});

test("#4899 web summaries: sessions carry costUsd/savedUsd/model; overview totals aggregate USD", async () => {
    resetState();
    const priced = getSession("web-money-1", { protocol: "anthropic", upstreamOrigin: "http://api.somehost.com" });
    priced.metadata.lastModel = "claude-bill";
    priced.stats.requests = 2;
    priced.metadata.cachePriceProfile = { w: 3.75, r: 0.3, q: 15 };
    priced.metadata.cacheLedger = { folds: [{ S: 50000, sigma: 5000, T: 3000, requestsAfter: 10 }] };
    priced.stats.costUsd = { input: 0.003, cacheRead: 0.00012, cacheWrite: 0.000375, output: 0.03 };
    const unpriced = getSession("web-money-2", { protocol: "anthropic", upstreamOrigin: "http://api.somehost.com" });
    unpriced.metadata.lastModel = "claude-unknown";
    unpriced.stats.requests = 2;
    unpriced.metadata.cacheLedger = { folds: [{ S: 90000, sigma: 9000, T: 9000, requestsAfter: 50 }] };

    const list = await buildSessionList();
    const row1 = list.find((s) => s.id === "web-money-1");
    assert.ok(row1);
    assert.equal(row1!.model, "claude-bill", "model id surfaced for the pricing editor");
    assert.ok(Math.abs(row1!.costUsd!.total - (0.003 + 0.00012 + 0.000375 + 0.03)) < 1e-12, "spend total sums the ledger");
    // savedUsd mirrors the kernel fold formula: (S−σ)·ra·r − [(w−r)·T + q·σ − r·S],
    // rounded to 4 decimals at the summary boundary (display precision).
    const perTurn = (50000 - 5000) * 10 * 0.3;
    const oneTime = (3.75 - 0.3) * 3000 + 15 * 5000 - 0.3 * 50000;
    const expectSaved = Math.round(((perTurn - oneTime) / 1e6) * 1e4) / 1e4;
    assert.ok(row1!.savedUsd !== undefined && Math.abs(row1!.savedUsd! - expectSaved) < 1e-9, `savedUsd ${row1!.savedUsd}`);
    const row2 = list.find((s) => s.id === "web-money-2");
    assert.ok(row2);
    assert.equal(row2!.costUsd, undefined, "unpriced: no spend row, tokens only");
    assert.equal(row2!.savedUsd, undefined, "no stamped profile: never priced on fabricated defaults");

    const ov = await buildOverview();
    assert.ok(Math.abs(ov.costUsdTotal - (0.003 + 0.00012 + 0.000375 + 0.03)) < 1e-12, "overview spend total");
    assert.ok(Math.abs(ov.savedUsdTotal - expectSaved) < 1e-9, "overview saved-$ total");
    assert.equal(ov.hasMoneyData, true, "money totals exist when any session is priced");

    // A world with no prices anywhere reports hasMoneyData=false (dash, not $0).
    resetState();
    seedSession("web-money-3", "claude-nobody");
    const ov2 = await buildOverview();
    assert.equal(ov2.hasMoneyData, false);
    assert.equal(ov2.costUsdTotal, 0);
    assert.equal(ov2.savedUsdTotal, 0);
});
