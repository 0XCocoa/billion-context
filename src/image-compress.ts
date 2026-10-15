import {
    applyImageFull,
    buildImageFullSystemNote,
    decideImageRoute,
    estimateImageTokens,
    IMAGE_FULL_FAILURE_MARKER,
    IMAGE_FULL_TOOL_NAME,
    imageShrinksForRef,
    isImageFullRestored,
    parseImageDimensionsFromBase64,
    parseImageFullInput,
    recordImageShrink,
    type Config,
    type DownsampleRecipe,
    type ImageFormat,
} from "acp-kernel";
import type { BiliMessage } from "acp-kernel/wire";
import { createHash } from "node:crypto";
import type { CompressSettings } from "./config.js";
import type { ResolvedImageBilling } from "./image-tokens.js";
import { log as loggerLog } from "./logger.js";
import type { Session } from "./session.js";
import { toolFail, toolOk, type ProxyToolResult } from "./proxy-tool-result.js";

// Image pre-compression host side (#1095 / acp-kernel#353). The kernel owns
// the pure decisions (routing, recipe, token estimation, image_full state
// machine); this module executes them at the forward boundary: rewrite the
// image bytes riding BiliMessage raw carriers BEFORE the wire rebuild, cache
// originals in memory, and serve the image_full restore channel.
//
// Determinism is load-bearing: the downsampled bytes become the standing wire
// content after arrival-time substitution (same invariant as #1097's CCR
// placeholders) — the encode recipe is fixed (see encodeDownsample) and every
// re-encode of the same input must yield identical bytes or the provider
// prefix cache dies mid-session.

export type ImageCompressionSettings = NonNullable<CompressSettings["imageCompression"]>;

const EFFECTIVE_IMAGE_COMPRESSION_KEY = "effectiveImageCompression";

/** Stamp the last-resolved image-compression policy onto the session
 *  (per-request; mirrors storeEffectiveCcr). */
export function storeEffectiveImageCompression(session: Session, imageCompression: ImageCompressionSettings | undefined): void {
    session.metadata[EFFECTIVE_IMAGE_COMPRESSION_KEY] = imageCompression ?? null;
}

/** Read back the policy stamped by {@link storeEffectiveImageCompression}. */
function effectiveImageCompression(session: Session | undefined): ImageCompressionSettings | undefined {
    const meta = session?.metadata[EFFECTIVE_IMAGE_COMPRESSION_KEY];
    if (meta && typeof meta === "object" && typeof (meta as ImageCompressionSettings).enabled === "boolean") {
        return meta as ImageCompressionSettings;
    }
    return undefined;
}

export function imageCompressionEnabled(session: Session | undefined): boolean {
    return effectiveImageCompression(session)?.enabled === true;
}

const EFFECTIVE_IMAGE_FULL_RESTORE_KEY = "effectiveImageFullRestore";

/** #3266: whether the restore CHANNEL (tool declaration + trailing note) may
 *  be advertised on this wire, independently of the downsample pass itself.
 *  Stamped per-request by handle() mirroring storeEffectiveImageCompression. */
export function storeImageFullRestoreArmed(session: Session, armed: boolean): void {
    session.metadata[EFFECTIVE_IMAGE_FULL_RESTORE_KEY] = armed;
}

/** #3266: read back the restore-channel stamp. Defaults to ARMED when absent
 *  (pre-#3266 builds stamped nothing) so unaudited paths keep the old
 *  behavior; only handle() explicitly disarms a known-unroutable host. */
export function imageFullRestoreArmed(session: Session | undefined): boolean {
    return session?.metadata[EFFECTIVE_IMAGE_FULL_RESTORE_KEY] !== false;
}

export { IMAGE_FULL_TOOL_NAME };

const FORMAT_MEDIA_TYPE: Record<ImageFormat, string> = {
    webp: "image/webp",
    jpeg: "image/jpeg",
    png: "image/png",
};

// [#1095] sharp is CJS-typed (`export =`): under ESM resolution the callable
// factory lives on `.default`, both in types and in Node's runtime interop.
type SharpFactory = typeof import("sharp").default;

let sharpState: { mod?: SharpFactory; failed?: boolean; loading?: Promise<SharpFactory | null> } = {};

function loadSharp(): Promise<SharpFactory | null> {
    if (sharpState.mod) return Promise.resolve(sharpState.mod);
    if (sharpState.failed) return Promise.resolve(null);
    if (!sharpState.loading) {
        sharpState.loading = import("sharp").then(
            (mod) => {
                const sharp = mod.default;
                sharpState.mod = sharp;
                return sharp;
            },
            () => {
                sharpState.failed = true;
                return null;
            },
        );
    }
    return sharpState.loading;
}

let sharpMissingWarned = false;

function warnSharpMissingOnce(log: LogFn): void {
    if (sharpMissingWarned) return;
    sharpMissingWarned = true;
    log("warn", "[acp-image] optional dependency 'sharp' is unavailable — image compression degrades to pass-through (npm install sharp to enable)");
}

type LogFn = (level: "info" | "warn" | "error", msg: string) => void;

/** Deterministic encode recipe (kernel #353 contract): resize fit-inside
 *  withoutEnlargement → EXIF-rotate → flatten alpha onto white → format
 *  encoder. Same input bytes + same sharp version ⇒ same output bytes. */
async function encodeDownsample(input: Buffer, recipe: DownsampleRecipe): Promise<Buffer | null> {
    const sharp = await loadSharp();
    if (!sharp) return null;
    let pipeline = sharp(input)
        .rotate()
        .resize(recipe.maxDimension, recipe.maxDimension, { fit: "inside", withoutEnlargement: true })
        .flatten({ background: "#ffffff" });
    if (recipe.format === "webp") pipeline = pipeline.webp({ quality: recipe.quality });
    else if (recipe.format === "jpeg") pipeline = pipeline.jpeg({ quality: recipe.quality, mozjpeg: true });
    else pipeline = pipeline.png({ compressionLevel: 9 });
    return pipeline.toBuffer();
}

function fingerprint(b64: string): string {
    return createHash("sha256").update(b64).digest("hex");
}

function splitDataUrl(url: string): { mediaType: string; b64: string } | null {
    if (!url.startsWith("data:")) return null;
    const comma = url.indexOf(",");
    if (comma < 0) return null;
    const head = url.slice(5, comma);
    if (!head.endsWith(";base64")) return null;
    const mediaType = head.slice(0, -7);
    if (!mediaType) return null;
    return { mediaType, b64: url.slice(comma + 1) };
}

interface ImageSlot {
    b64: string;
    mediaType: string;
    replace(b64: string, mediaType: string): void;
}

function anthropicSlots(m: BiliMessage): ImageSlot[] {
    const block = m.rawAnthropicBlock as Record<string, unknown> | undefined;
    if (!block || typeof block !== "object" || block.type !== "image") return [];
    const source = block.source as Record<string, unknown> | undefined;
    if (!source || source.type !== "base64" || typeof source.data !== "string" || typeof source.media_type !== "string") return [];
    return [{
        b64: source.data,
        mediaType: source.media_type,
        replace(b64: string, mediaType: string): void {
            source.data = b64;
            source.media_type = mediaType;
        },
    }];
}

function openaiSlots(m: BiliMessage): ImageSlot[] {
    const out: ImageSlot[] = [];
    const pushPart = (part: unknown): void => {
        const p = part as Record<string, unknown> | undefined;
        if (!p || typeof p !== "object" || p.type !== "image_url") return;
        const imageUrl = p.image_url as Record<string, unknown> | undefined;
        if (!imageUrl) return;
        const url = imageUrl.url;
        if (typeof url !== "string") return;
        const parsed = splitDataUrl(url);
        if (!parsed) return;
        out.push({
            b64: parsed.b64,
            mediaType: parsed.mediaType,
            replace(b64: string, mediaType: string): void {
                imageUrl.url = `data:${mediaType};base64,${b64}`;
            },
        });
    };
    if (Array.isArray(m.rawOpenaiContentParts)) {
        for (const part of m.rawOpenaiContentParts) pushPart(part);
    } else if (typeof m.rawOpenaiContent === "string") {
        const parsed = splitDataUrl(m.rawOpenaiContent);
        if (parsed) {
            out.push({
                b64: parsed.b64,
                mediaType: parsed.mediaType,
                replace(b64: string, mediaType: string): void {
                    (m as { rawOpenaiContent: unknown }).rawOpenaiContent = `data:${mediaType};base64,${b64}`;
                },
            });
        }
    }
    return out;
}

function responsesSlots(m: BiliMessage): ImageSlot[] {
    const item = m.rawResponsesItem as Record<string, unknown> | undefined;
    if (!item || typeof item !== "object" || !Array.isArray(item.content)) return [];
    const out: ImageSlot[] = [];
    for (const part of item.content as unknown[]) {
        const p = part as Record<string, unknown> | undefined;
        if (!p || typeof p !== "object" || p.type !== "input_image") continue;
        const url = p.image_url;
        if (typeof url !== "string") continue;
        const parsed = splitDataUrl(url);
        if (!parsed) continue;
        out.push({
            b64: parsed.b64,
            mediaType: parsed.mediaType,
            replace(b64: string, mediaType: string): void {
                p.image_url = `data:${mediaType};base64,${b64}`;
            },
        });
    }
    return out;
}

function googleSlots(m: BiliMessage): ImageSlot[] {
    if (!Array.isArray(m.rawGoogleParts)) return [];
    const out: ImageSlot[] = [];
    for (const part of m.rawGoogleParts as unknown[]) {
        const p = part as Record<string, unknown> | undefined;
        if (!p || typeof p !== "object") continue;
        const inline = p.inlineData as Record<string, unknown> | undefined;
        if (!inline || typeof inline.data !== "string" || typeof inline.mimeType !== "string") continue;
        out.push({
            b64: inline.data,
            mediaType: inline.mimeType,
            replace(b64: string, mediaType: string): void {
                inline.data = b64;
                inline.mimeType = mediaType;
            },
        });
    }
    return out;
}

/** All image slots carried by one message, deduped by payload fingerprint
 *  (the mirror fields are bookkeeping, never slots). */
function imageSlots(m: BiliMessage): ImageSlot[] {
    const seen = new Set<string>();
    const out: ImageSlot[] = [];
    for (const slot of [...anthropicSlots(m), ...openaiSlots(m), ...responsesSlots(m), ...googleSlots(m)]) {
        const fp = fingerprint(slot.b64);
        if (seen.has(fp)) continue;
        seen.add(fp);
        out.push(slot);
    }
    return out;
}

/** Keep the mirror bookkeeping fields in sync when the image they describe
 *  was rewritten (they hold the FIRST image of the message — compare before
 *  touching so a multi-image message shrunk elsewhere stays untouched). */
function syncMirrors(m: BiliMessage, oldB64: string, newB64: string, newMediaType: string): void {
    if (m.imageBase64 === oldB64) {
        m.imageBase64 = newB64;
        m.imageMediaType = newMediaType;
    }
}

const MAX_ENCODE_CACHE_ENTRIES = 256;

function noteFingerprintByRef(session: Session, ref: string, fp: string): void {
    if (!session.imageFingerprintsByRef) session.imageFingerprintsByRef = new Map();
    const fps = session.imageFingerprintsByRef.get(ref) ?? [];
    if (!fps.includes(fp)) fps.push(fp);
    session.imageFingerprintsByRef.set(ref, fps);
}

function invalidateForRef(session: Session, ref: string): void {
    const fps = session.imageFingerprintsByRef?.get(ref);
    if (fps && session.imageEncodeCache) {
        for (const fp of fps) session.imageEncodeCache.delete(fp);
    }
    session.imageFingerprintsByRef?.delete(ref);
}

/** Arrival-time downsample pass over the prepared message list (mutates the
 *  raw carriers in place — never replaces message refs, so downstream views
 *  see the rewritten bytes). Skips restored refs (image_full), skips
 *  unreferenced messages (ephemeral), never throws (per-slot catch →
 *  pass-through). Idempotent: recorded refs re-encode deterministically via
 *  the fingerprint cache. */
export async function applyImageCompressionPass(session: Session, messages: BiliMessage[], opts: { config: Config; billing: ResolvedImageBilling; cap?: number; log?: LogFn }): Promise<void> {
    if (!imageCompressionEnabled(session)) return;
    const log: LogFn = opts.log ?? ((level, msg) => loggerLog(level, msg));
    // #1843-L3: the saved-token stat must agree with the window accounting —
    // an operator-declared imageTokenCap bounds every billed cost, so bound
    // the recorded before/after too. The ROUTING decision stays uncapped: the
    // cap is a billing ceiling, not a statement about the image's physical
    // size, and shrinking bytes is still worth doing.
    const capCost = (n: number): number => (opts.cap !== undefined && opts.cap > 0 ? Math.min(n, opts.cap) : n);
    let shrunkThisPass = 0;
    let bytesSaved = 0;
    let tokensSaved = 0;
    for (const m of messages) {
        if (typeof m.id !== "string") continue;
        const ref = session.state.messageRefs.byRaw[m.id];
        if (!ref) continue;
        if (isImageFullRestored(session.state, ref)) continue;
        const slots = imageSlots(m);
        if (slots.length === 0) continue;
        // A ref already shrunk earlier may come back carrying OUR emitted
        // bytes (e.g. a folded re-request built from processed messages): only
        // known-original payloads may be touched, or we double-shrink and the
        // standing wire bytes stop being byte-stable (prefix-cache invariant).
        // Captured pre-loop so records created mid-loop never block siblings.
        const shrinkRecords = imageShrinksForRef(session.state, ref);
        const hadRecord = shrinkRecords.length > 0;
        const knownOriginalFps = [...(session.imageFingerprintsByRef?.get(ref) ?? [])];
        for (const slot of slots) {
            try {
                const fp = fingerprint(slot.b64);
                // #3266: after a state reload (process restart, LRU evict+reload)
                // the persisted records survive but the in-memory fingerprint map
                // is gone. Recognize the original by its recorded byte size — the
                // keep-smaller rule below makes any shrunk output strictly smaller
                // than the original, so an exact size match is unambiguous. Without
                // this the slot passes through forever and the full-size original
                // bytes ride the wire indefinitely (the feature silently off).
                if (hadRecord && !knownOriginalFps.includes(fp) && !shrinkRecords.some((r) => r.originalBytes === Math.ceil(slot.b64.length * 3 / 4))) continue;
                const cached = session.imageEncodeCache?.get(fp);
                let shrunk: { b64: string; mediaType: string; format: ImageFormat } | null = cached ? { ...cached, format: cachedFormat(cached.mediaType) } : null;
                if (!shrunk) {
                    const dims = parseImageDimensionsFromBase64(slot.b64);
                    const decision = decideImageRoute(
                        { mediaType: slot.mediaType, base64Length: slot.b64.length, width: dims?.width, height: dims?.height, billing: opts.billing, base64: slot.b64 },
                        opts.config,
                    );
                    if (decision.action !== "downsample" || !decision.recipe) continue;
                    const origBuf = Buffer.from(slot.b64, "base64");
                    const encoded = await encodeDownsample(origBuf, decision.recipe);
                    if (!encoded) {
                        warnSharpMissingOnce(log);
                        continue;
                    }
                    // Keep-smaller rule: a lossy encode that does not beat the
                    // original bytes buys nothing (and changes the pixels) —
                    // pass through untouched.
                    if (encoded.length >= origBuf.length) continue;
                    shrunk = { b64: encoded.toString("base64"), mediaType: FORMAT_MEDIA_TYPE[decision.recipe.format], format: decision.recipe.format };
                    if (!session.imageEncodeCache) session.imageEncodeCache = new Map();
                    while (session.imageEncodeCache.size >= MAX_ENCODE_CACHE_ENTRIES) {
                        const oldest = session.imageEncodeCache.keys().next().value as string | undefined;
                        if (oldest === undefined) break;
                        session.imageEncodeCache.delete(oldest);
                    }
                    session.imageEncodeCache.set(fp, { b64: shrunk.b64, mediaType: shrunk.mediaType });
                }
                const origB64 = slot.b64;
                const origMediaType = slot.mediaType;
                slot.replace(shrunk.b64, shrunk.mediaType);
                syncMirrors(m, origB64, shrunk.b64, shrunk.mediaType);
                noteFingerprintByRef(session, ref, fp);
                if (imageShrinksForRef(session.state, ref).length === 0) {
                    const dimBefore = parseImageDimensionsFromBase64(origB64);
                    const dimAfter = parseImageDimensionsFromBase64(shrunk.b64);
                    const tokensBefore = capCost(estimateImageTokens({ mediaType: origMediaType, base64Length: origB64.length, width: dimBefore?.width, height: dimBefore?.height, billing: opts.billing, base64: origB64 }));
                    const tokensAfter = capCost(estimateImageTokens({ mediaType: shrunk.mediaType, base64Length: shrunk.b64.length, width: dimAfter?.width, height: dimAfter?.height, billing: opts.billing, base64: shrunk.b64 }));
                    const originalBytes = Math.ceil(origB64.length * 3 / 4);
                    const shrunkBytes = Math.ceil(shrunk.b64.length * 3 / 4);
                    session.state = recordImageShrink(session.state, {
                        ref,
                        rawMessageId: m.id,
                        mediaType: origMediaType,
                        format: shrunk.format,
                        originalBytes,
                        shrunkBytes,
                        tokensBefore,
                        tokensAfter,
                        createdAt: Date.now(),
                    });
                    bytesSaved += originalBytes - shrunkBytes;
                    tokensSaved += tokensBefore - tokensAfter;
                    shrunkThisPass += 1;
                    log("info", `[acp-image] [${session.id}] ${ref}: ${origMediaType} ${originalBytes}B→${shrunkBytes}B (${tokensBefore}→${tokensAfter} tok, saved ${originalBytes - shrunkBytes}B/${tokensBefore - tokensAfter} tok)`);
                }
            } catch (err) {
                log("warn", `[${session.id}] image compression failed for ${ref}: ${String(err)} — passing through`);
            }
        }
    }
    if (shrunkThisPass > 0) {
        session.stats.imageShrunkCount = (session.stats.imageShrunkCount ?? 0) + shrunkThisPass;
        session.stats.imageBytesSaved = (session.stats.imageBytesSaved ?? 0) + bytesSaved;
        session.stats.imageTokensSaved = (session.stats.imageTokensSaved ?? 0) + tokensSaved;
    }
}

function cachedFormat(mediaType: string): ImageFormat {
    if (mediaType === "image/jpeg") return "jpeg";
    if (mediaType === "image/png") return "png";
    return "webp";
}

/** #3266: refs whose shrunken payload is currently restorable — a shrink
 *  record exists, the ref is not yet restored, and the ref still resolves in
 *  the live ref map (a pruned ref would be rejected by image_full anyway —
 *  listing it would feed exactly the guessing loop this exists to kill).
 *  Sorted by ref number so the note bytes are stable across rounds. */
export function restorableRefs(session: Session): string[] {
    const byRef = session.state.messageRefs.byRef;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of session.state.imageShrinks ?? []) {
        if (seen.has(r.ref)) continue;
        seen.add(r.ref);
        if (isImageFullRestored(session.state, r.ref)) continue;
        if (!byRef[r.ref]) continue;
        out.push(r.ref);
    }
    return out.sort((a, b) => Number(a.replace(/\D/g, "")) - Number(b.replace(/\D/g, "")) || a.localeCompare(b));
}

const MAX_LISTED_REFS = 20;

function formatRefList(refs: string[]): string {
    const listed = refs.slice(0, MAX_LISTED_REFS);
    const extra = refs.length - listed.length;
    return `${listed.join(", ")}${extra > 0 ? `, +${extra} more` : ""}`;
}

/** #3266: consecutive-failure guardrail threshold — at this many failures in
 *  a row the restore note stops being injected (a model guessing refs burns a
 *  full re-request per failure; the nudge then amplifies the storm instead of
 *  fixing it). Any success resets the streak and re-arms the note. */
const IMAGE_FULL_NOTE_SUPPRESS_STREAK = 2;

/** #3266: appended to every failed image_full receipt — the model must never
 *  learn which refs are restorable from guesswork. */
function restorableRefsSuffix(session: Session): string {
    const refs = restorableRefs(session);
    return refs.length > 0
        ? `\nRestorable refs in this session (use exactly one as the ref argument): ${formatRefList(refs)}.`
        : "\nNo downscaled image in this session is currently restorable.";
}

function bumpFailStreak(session: Session): void {
    const streak = (session.stats.imageFullFailStreak ?? 0) + 1;
    session.stats.imageFullFailStreak = streak;
    if (streak === IMAGE_FULL_NOTE_SUPPRESS_STREAK) {
        loggerLog("warn", `[acp-image] [${session.id}] ${streak} consecutive image_full failures — restore note suppressed until a successful restore`);
    }
}

/** Execute one image_full call (sticky restore for the rest of the session).
 *  Mirrors executeRetrieve's shape; the restore itself is passive — the next
 *  forward pass emits the cached/original bytes for the ref. */
export function executeImageFull(args: Record<string, unknown>, session: Session, config: Config, callId?: string): ProxyToolResult {
    session.stats.imageFullCalls = (session.stats.imageFullCalls ?? 0) + 1;
    const parsed = parseImageFullInput(args, callId, (w) => loggerLog("info", `[acp-image] [${session.id}] ${w}`));
    if (!parsed) {
        bumpFailStreak(session);
        return toolFail(`${IMAGE_FULL_FAILURE_MARKER} invalid input — expected { ref: "mNNNNN" }${restorableRefsSuffix(session)}`);
    }
    const wasRestored = isImageFullRestored(session.state, parsed.ref);
    const outcome = applyImageFull({ ref: parsed.ref, state: session.state, config });
    session.state = outcome.state;
    if (outcome.ok) {
        if (session.stats.imageFullFailStreak !== 0) session.stats.imageFullFailStreak = 0;
        if (!wasRestored) {
            session.stats.imageFullRestores = (session.stats.imageFullRestores ?? 0) + 1;
            invalidateForRef(session, parsed.ref);
            loggerLog("info", `[acp-image] [${session.id}] image_full ${parsed.ref}: restored to full resolution for the rest of the session`);
        } else {
            loggerLog("info", `[acp-image] [${session.id}] image_full ${parsed.ref}: already restored (no-op)`);
        }
        return toolOk(outcome.resultText);
    }
    bumpFailStreak(session);
    loggerLog("info", `[acp-image] [${session.id}] image_full ${parsed.ref}: rejected (${outcome.resultText})`);
    return toolFail(`${outcome.resultText}${restorableRefsSuffix(session)}`);
}

/** #3266: plain-text variant served when the host cannot route image_full
 *  back to us (e.g. codex on the responses wire rejects bili-injected tools
 *  and records a synthetic "unsupported call" output for them — every
 *  round-trip forks the host history from ours). The downsampled images stay
 *  downsampled; the model is told up front so it does not attempt a path
 *  that can never succeed here. */
function notRestorableNote(count: number): string {
    return `[Downscaled screenshots: ${count} image(s) in this session were reduced before entering context and CANNOT be restored to their original resolution in this session. Read what you can from the reduced images; do not call image_full.]`;
}

/** Trailing-message guidance for the model: how many images are currently
 *  downscaled (and not yet restored). Rides as an ephemeral trailing user
 *  message (nudge pattern) — NEVER in the system prompt, where a changing
 *  count would bust the whole prefix cache. #3266: carries the actual
 *  restorable refs (the model previously had to guess), degrades to plain
 *  text when the host cannot route image_full, and self-suppresses after
 *  IMAGE_FULL_NOTE_SUPPRESS_STREAK consecutive failures. */
export function imageFullTrailingNote(session: Session | undefined): string | undefined {
    if (!imageCompressionEnabled(session)) return undefined;
    const records = session!.state.imageShrinks ?? [];
    const active = records.filter((r) => !isImageFullRestored(session!.state, r.ref)).length;
    if (active === 0) return undefined;
    const refs = restorableRefs(session!);
    if (!imageFullRestoreArmed(session) || refs.length === 0) return notRestorableNote(active);
    if ((session!.stats.imageFullFailStreak ?? 0) >= IMAGE_FULL_NOTE_SUPPRESS_STREAK) return undefined;
    return `${buildImageFullSystemNote(active)}\nRestorable refs (call image_full with exactly one of these): ${formatRefList(refs)}.`;
}

/** Per-request [acp-usage] suffix: cumulative image savings for the session.
 *  Gated on bytes OR tokens — the kernel's pixel-tile estimate is coarse and
 *  capped, so a shrink can save real wire bytes while saving zero tokens. */
export function imageUsageSuffix(session: Session | undefined): string {
    const tok = session?.stats.imageTokensSaved ?? 0;
    const bytes = session?.stats.imageBytesSaved ?? 0;
    if (tok <= 0 && bytes <= 0) return "";
    return ` img-saved=${tok}tok/${Math.round(bytes / 1024)}KB x${session!.stats.imageShrunkCount ?? 0}`;
}
