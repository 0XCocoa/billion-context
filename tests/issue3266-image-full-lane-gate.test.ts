import test from "node:test";
import assert from "node:assert/strict";

process.env.BILI_PERSIST = "0";

import sharp from "sharp";
import { IMAGE_FULL_FAILURE_MARKER, defaultConfig, imageShrinksForRef } from "acp-kernel";
import type { BiliMessage } from "acp-kernel/wire";
import { applyCompressSettings } from "../src/compress-settings.ts";
import {
    applyImageCompressionPass,
    executeImageFull,
    imageFullRestoreArmed,
    imageFullTrailingNote,
    restorableRefs,
    storeEffectiveImageCompression,
    storeImageFullRestoreArmed,
} from "../src/image-compress.ts";
import { getSession, type Session } from "../src/session.ts";

interface Fixture { b64: string; mediaType: string; width: number; height: number; bytes: number }

async function makeFixture(width: number, height: number, patterned: boolean): Promise<Fixture> {
    const raw = Buffer.alloc(width * height * 3);
    if (patterned) {
        for (let i = 0; i < raw.length; i += 3) {
            raw[i] = i & 0xff;
            raw[i + 1] = (i * 7) & 0xff;
            raw[i + 2] = (i * 13) & 0xff;
        }
    } else {
        raw.fill(0x88);
    }
    const buf = await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
    return { b64: buf.toString("base64"), mediaType: "image/png", width, height, bytes: buf.length };
}

// Same fixtures as tests/image-compress.test.ts: 2048×2944 patterned routes to
// downsample; the encode cache keys on content, so many messages sharing one
// fixture cost a single sharp encode.
let shotCache: Fixture | undefined;
async function shot(): Promise<Fixture> {
    return (shotCache ??= await makeFixture(2048, 2944, true));
}

function armedSession(byRaw: Record<string, string>): Session {
    const s = getSession(`img3266-${Math.random().toString(36).slice(2)}`);
    storeEffectiveImageCompression(s, { enabled: true });
    for (const [raw, ref] of Object.entries(byRaw)) {
        s.state.messageRefs.byRaw[raw] = ref;
        s.state.messageRefs.byRef[ref] = raw;
    }
    return s;
}

function enabledCfg(extra: Record<string, unknown> = {}): ReturnType<typeof defaultConfig> {
    return applyCompressSettings(defaultConfig(200_000), 200_000, { imageCompression: { enabled: true, ...extra } });
}

function anthropicMsg(id: string, fx: Fixture): BiliMessage {
    return {
        id,
        role: "user",
        contentType: "text",
        text: "",
        rawAnthropicBlock: { type: "image", source: { type: "base64", media_type: fx.mediaType, data: fx.b64 } },
    };
}

function antData(m: BiliMessage): string {
    return (m.rawAnthropicBlock as unknown as { source: { data: string } }).source.data;
}

const logsOf = (): { logs: string[]; log: (level: "info" | "warn" | "error", msg: string) => void } => {
    const logs: string[] = [];
    return { logs, log: (level, msg) => logs.push(`${level}|${msg}`) };
};

test("#3266 note lists the exact restorable refs; restored and pruned refs are excluded", async () => {
    const fx = await shot();
    const s = armedSession({ r1: "m00001", r2: "m00002", r3: "m00003" });
    const cfg = enabledCfg();
    await applyImageCompressionPass(s, [anthropicMsg("r1", fx), anthropicMsg("r2", fx), anthropicMsg("r3", fx)], { config: cfg, billing: "pixels" });
    assert.deepEqual(restorableRefs(s), ["m00001", "m00002", "m00003"]);

    // m00002 gets restored → out of the list; m00003's ref is pruned from the
    // live map (compaction archive) → listing it would only feed rejections.
    executeImageFull({ ref: "m00002" }, s, cfg);
    delete s.state.messageRefs.byRef["m00003"];
    assert.deepEqual(restorableRefs(s), ["m00001"]);

    const note = imageFullTrailingNote(s);
    assert.ok(note !== undefined);
    assert.ok(note.includes("Restorable refs"));
    assert.ok(note.includes("m00001"));
    assert.ok(!note.includes("m00002"));
    assert.ok(!note.includes("m00003"));
});

test("#3266 note caps the ref list at 20 with a remainder marker", async () => {
    const fx = await shot();
    const byRaw: Record<string, string> = {};
    for (let i = 1; i <= 25; i++) byRaw[`r${i}`] = `m${String(i).padStart(5, "0")}`;
    const s = armedSession(byRaw);
    const cfg = enabledCfg();
    const msgs = Object.entries(byRaw).map(([raw]) => anthropicMsg(raw, fx));
    await applyImageCompressionPass(s, msgs, { config: cfg, billing: "pixels" });
    assert.equal(imageShrinksForRef(s.state, "m00025").length, 1);

    const note = imageFullTrailingNote(s);
    assert.ok(note !== undefined);
    assert.ok(note.includes("m00020"));
    assert.ok(!note.includes("m00021"));
    assert.ok(note.includes("+5 more"));
});

test("#3266 disarmed lane serves the plain not-restorable note instead of a tool promise", async () => {
    const fx = await shot();
    const s = armedSession({ r1: "m00001" });
    const cfg = enabledCfg();
    await applyImageCompressionPass(s, [anthropicMsg("r1", fx)], { config: cfg, billing: "pixels" });

    // Default when never stamped: ARMED (pre-#3266 behavior for unaudited paths).
    assert.equal(imageFullRestoreArmed(s), true);
    assert.ok(imageFullTrailingNote(s)?.includes("Restorable refs"));

    storeImageFullRestoreArmed(s, false);
    const note = imageFullTrailingNote(s);
    assert.ok(note !== undefined);
    assert.ok(note.includes("CANNOT be restored"));
    assert.ok(!note.includes("Restorable refs"));
    assert.ok(note.includes("do not call image_full"));
});

test("#3266 two consecutive failures suppress the armed note; a success re-arms it", async () => {
    const fx = await shot();
    const s = armedSession({ r1: "m00001", r2: "m00002" });
    const cfg = enabledCfg();
    await applyImageCompressionPass(s, [anthropicMsg("r1", fx), anthropicMsg("r2", fx)], { config: cfg, billing: "pixels" });
    assert.ok(imageFullTrailingNote(s) !== undefined);

    executeImageFull({ ref: "m99999" }, s, cfg);
    assert.equal(s.stats.imageFullFailStreak, 1);
    assert.ok(imageFullTrailingNote(s) !== undefined);

    executeImageFull({}, s, cfg);
    assert.equal(s.stats.imageFullFailStreak, 2);
    assert.equal(imageFullTrailingNote(s), undefined);

    // A real restore resets the streak; m00002 stays active so the note returns.
    const ok = executeImageFull({ ref: "m00001" }, s, cfg);
    assert.ok(!ok.text.startsWith(IMAGE_FULL_FAILURE_MARKER));
    assert.equal(s.stats.imageFullFailStreak, 0);
    const note = imageFullTrailingNote(s);
    assert.ok(note !== undefined);
    assert.ok(note.includes("m00002"));
});

test("#3266 failed receipts carry the restorable ref list (or an explicit none)", async () => {
    const fx = await shot();
    const withRef = armedSession({ r1: "m00001" });
    const cfg = enabledCfg();
    await applyImageCompressionPass(withRef, [anthropicMsg("r1", fx)], { config: cfg, billing: "pixels" });

    const rejected = executeImageFull({ ref: "m99999" }, withRef, cfg);
    assert.ok(rejected.text.startsWith(IMAGE_FULL_FAILURE_MARKER));
    assert.ok(rejected.text.includes("Restorable refs in this session"));
    assert.ok(rejected.text.includes("m00001"));

    const parseFail = executeImageFull({}, withRef, cfg);
    assert.ok(parseFail.text.includes("invalid input"));
    assert.ok(parseFail.text.includes("m00001"));

    const empty = armedSession({});
    const none = executeImageFull({ ref: "m00001" }, empty, cfg);
    assert.ok(none.text.startsWith(IMAGE_FULL_FAILURE_MARKER));
    assert.ok(none.text.includes("No downscaled image in this session is currently restorable"));

    const success = executeImageFull({ ref: "m00001" }, withRef, cfg);
    assert.ok(!success.text.startsWith(IMAGE_FULL_FAILURE_MARKER));
    assert.ok(!success.text.includes("Restorable refs"));
});

test("#3266 after a state reload the original bytes are recognized by size and re-shrunk without duplicate records or logs", async () => {
    const fx = await shot();
    const s = armedSession({ r1: "m00001" });
    const cfg = enabledCfg();
    const first = anthropicMsg("r1", fx);
    const { logs, log } = logsOf();
    await applyImageCompressionPass(s, [first], { config: cfg, billing: "pixels", log });
    const shrunkB64 = antData(first);
    assert.notEqual(shrunkB64, fx.b64);
    assert.equal(logs.filter((l) => l.startsWith("info")).length, 1);

    // Simulate a process restart / LRU evict+reload: persisted records survive,
    // the host-side fingerprint map and encode cache are gone.
    s.imageFingerprintsByRef = undefined;
    s.imageEncodeCache = undefined;

    const second = anthropicMsg("r1", fx);
    logs.length = 0;
    await applyImageCompressionPass(s, [second], { config: cfg, billing: "pixels", log });
    assert.equal(antData(second), shrunkB64);
    assert.equal(imageShrinksForRef(s.state, "m00001").length, 1);
    assert.equal(s.stats.imageShrunkCount, 1);
    assert.equal(logs.filter((l) => l.startsWith("info")).length, 0);
});

test("#3266 shrink log carries the session id", async () => {
    const fx = await shot();
    const s = armedSession({ r1: "m00001" });
    const { logs, log } = logsOf();
    await applyImageCompressionPass(s, [anthropicMsg("r1", fx)], { config: enabledCfg(), billing: "pixels", log });
    assert.ok(logs.some((l) => l.includes(`[acp-image] [${s.id}] m00001:`)));
});
