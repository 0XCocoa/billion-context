/**
 * Unified-storage sidecar (#2671).
 *
 * Two opt-in levels via BILI_STORAGE_UNIFIED:
 *   - `1`/`true`/`shadow` (Phase 1): double-write dry-run. Every session
 *     record the legacy SessionStore commits is ALSO ingested into
 *     <sessionsDir>/index.db, and the reconstructed view is digest-checked
 *     against what the legacy loader (buildSession) would serve after a
 *     restart. Any drift is logged as an error — that is the entire point:
 *     the unified layer must replay legacy bytes exactly, and production
 *     traffic becomes the migration test corpus.
 *   - `full` (Phase 1.5): the drop-in replacement. Reads flip to
 *     unified-first with organic import (a session the index has not seen
 *     is imported from its legacy file on first load) and legacy fallback
 *     on any miss. Legacy files keep being written (rollback = unset the
 *     env), but the unified index is the load path.
 *
 * Failure policy: sidecar problems must NEVER break the legacy write path.
 * All work is try/catch'd; after MAX_CONSECUTIVE_FAILURES consecutive
 * failures the sidecar disables itself for the process (warn once) — in
 * full mode that also flips reads back to legacy-only.
 */

import { log as loggerLog } from "../logger.js";
import { planIngest, loadLegacyView, type LegacySessionLike } from "./ingest.ts";
import { resolveStorageMode, type StorageMode } from "../knobs.ts";
import { UnifiedStore, type CheckpointRow } from "./store.ts";
import { canonicalize, sha256 } from "./canonical.ts";
import { makeSessionKey, resolveAgentNamespace } from "./key.ts";

const MAX_CONSECUTIVE_FAILURES = 3;

// Canonical home for StorageMode/resolveStorageMode is src/knobs.ts (env-var
// discipline, #2030); re-exported here for the storage-layer importers.
export { resolveStorageMode, type StorageMode } from "../knobs.ts";

interface ShadowStats {
    ingests: number;
    verifyOk: number;
    verifyDrift: number;
    imports: number;
    disabled: boolean;
    lastError: string | null;
}

export class UnifiedShadow {
    readonly mode: StorageMode;
    readonly stats: ShadowStats = { ingests: 0, verifyOk: 0, verifyDrift: 0, imports: 0, disabled: false, lastError: null };
    private readonly store: UnifiedStore;
    private readonly legacyLoad: (record: unknown) => LegacySessionLike | null;
    private consecutiveFailures = 0;

    private constructor(mode: StorageMode, store: UnifiedStore, legacyLoad: (record: unknown) => LegacySessionLike | null) {
        this.mode = mode;
        this.store = store;
        this.legacyLoad = legacyLoad;
    }

    /** Opens the sidecar when a knob asks for one; null (no cost) otherwise. */
    static maybeOpen(
        dir: string,
        env: NodeJS.ProcessEnv = process.env,
        legacyLoad?: (record: unknown) => LegacySessionLike | null,
        fileUnified?: string,
    ): UnifiedShadow | null {
        const mode = resolveStorageMode(env, fileUnified);
        if (mode === "legacy") return null;
        let store: UnifiedStore;
        try {
            store = UnifiedStore.open(`${dir}/index.db`);
        } catch (err) {
            // #2771: a corrupt/unreadable index.db must degrade to legacy-only
            // (same shape as the encryption opt-out), never brick SessionStore
            // construction. No auto-delete: the index may hold pinned checkpoint
            // blobs (#2671 Phase 2) — destructive recovery is operator policy.
            loggerLog(
                "warn",
                `[storage] unified sidecar failed to open ${dir}/index.db (${String(err)}) — staying legacy-only; delete the file to reset the index`,
            );
            return null;
        }
        const shadow = new UnifiedShadow(mode, store, legacyLoad ?? (() => null));
        loggerLog(
            "info",
            mode === "full"
                ? "[storage] unified FULL mode ENABLED (storage.unified=full or BILI_STORAGE_UNIFIED=full): index.db is the load path (unified-first, legacy fallback); legacy files keep being written — unset the knob to roll back"
                : "[storage] unified shadow mode ENABLED (storage.unified=shadow or BILI_STORAGE_UNIFIED): every session write is double-ingested into index.db and digest-reconciled",
        );
        return shadow;
    }

    /** True when reads should go unified-first (full mode, sidecar healthy). */
    get readsUnified(): boolean {
        return this.mode === "full" && !this.stats.disabled;
    }

    /** Ingest + verify one committed record. Never throws. */
    record(record: unknown): void {
        if (this.stats.disabled) return;
        try {
            const legacy = this.legacyLoad(record);
            if (!legacy) return;
            // Exact composite key — the same one planIngest mints from the
            // same metadata — so the post-ingest lookup never pays for (and
            // never warns about) a cross-agent collision.
            const key = makeSessionKey(resolveAgentNamespace(legacy.metadata), legacy.id);
            const plan = planIngest(legacy);
            this.store.ingestSession(plan);
            this.stats.ingests++;
            const sessionRow = this.store.getSessionRow(key);
            if (!sessionRow) throw new Error(`session row missing after ingest: ${legacy.id}`);
            const rows = {
                session: sessionRow,
                messages: this.store.getMessages(key),
                blocks: this.store.getBlocks(key),
                deadRefs: this.store.getDeadRefs(key),
                refs: this.store.getRefs(key),
            };
            const expect = shadowDigest(legacy);
            const got = shadowDigest(loadLegacyView(rows));
            if (got !== expect) {
                this.stats.verifyDrift++;
                loggerLog("error", `[storage] unified shadow DIGEST DRIFT for ${legacy.id}: unified replay != legacy load view — migration parity broken, report this`);
            } else {
                this.stats.verifyOk++;
            }
            this.consecutiveFailures = 0;
        } catch (err) {
            this.consecutiveFailures++;
            this.stats.lastError = String(err);
            if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                this.stats.disabled = true;
                loggerLog("warn", `[storage] unified shadow disabled after ${this.consecutiveFailures} consecutive failures (last: ${String(err)})`);
            }
        }
    }

    /** Loads the unified view of one session (full mode read path). `id` is
     *  the bare conversation id; an optional agent hint pins the exact row
     *  when several agents share the id (near-impossible in practice).
     *  Returns null on miss — the caller falls back to the legacy file. */
    viewFor(id: string, hint?: { agent?: string }): LegacySessionLike | null {
        if (this.stats.disabled) return null;
        try {
            const sessionRow = this.store.getSessionRow(hint?.agent ? makeSessionKey(hint.agent, id) : id);
            if (!sessionRow) return null;
            // The row's sessionId is the bare conv_id column; child tables are
            // keyed by the full composite, so re-derive it from the pair.
            const key = makeSessionKey(sessionRow.agent, sessionRow.sessionId);
            const rows = {
                session: sessionRow,
                messages: this.store.getMessages(key),
                blocks: this.store.getBlocks(key),
                deadRefs: this.store.getDeadRefs(key),
                refs: this.store.getRefs(key),
            };
            // The view's `state` object carries every MERGE_STATE_FIELDS key by
            // construction; the declared Record<string, unknown> just needs a
            // widening cast to reach LegacySessionLike.
            return loadLegacyView(rows) as LegacySessionLike;
        } catch (err) {
            loggerLog("warn", `[storage] unified load failed for ${id} (${String(err)}) — falling back to the legacy file`);
            return null;
        }
    }

    /** Organic import (full mode): ingest a legacy record the index has not
     *  seen so future loads serve from the unified store. Never throws. */
    importRecord(record: unknown): LegacySessionLike | null {
        if (this.stats.disabled) return null;
        try {
            const legacy = this.legacyLoad(record);
            if (!legacy) return null;
            this.store.ingestSession(planIngest(legacy));
            this.stats.imports++;
            loggerLog("info", `[storage] unified import on first open: ${legacy.id}`);
            return legacy;
        } catch (err) {
            loggerLog("warn", `[storage] unified import failed for a legacy record (${String(err)}) — serving the legacy view`);
            return null;
        }
    }

    /** GC parity: remove the session's rows when the legacy files are deleted.
     *  The agent hint pins the exact row; without it the row is resolved from
     *  the store first — the birth-frozen agent may differ from a fresh
     *  metadata resolution, so the key is never constructed blind. */
    remove(id: string, agentHint?: string): void {
        if (this.stats.disabled) return;
        try {
            const key = agentHint ? makeSessionKey(agentHint, id) : this.resolveKey(id);
            if (!key) return; // nothing ingested — parity with legacy no-op
            this.store.deleteSession(key);
        } catch (err) {
            loggerLog("warn", `[storage] unified remove failed for ${id} (${String(err)})`);
        }
    }

    /** Full opaque key of the row owning `id`, or null when uningested. */
    private resolveKey(id: string): string | null {
        const row = this.store.getSessionRow(id);
        return row ? makeSessionKey(row.agent, row.sessionId) : null;
    }

    // ---- Phase 2 checkpoints/replicas (#2671) -------------------------------
    // Thin pass-throughs so callers never touch the raw UnifiedStore. All
    // throw (never log-and-swallow): replica management is an explicit
    // operator action, unlike the never-throw shadow mirrors above.

    createCheckpoint(cp: Parameters<UnifiedStore["insertCheckpoint"]>[0]): void {
        this.assertLive();
        this.store.insertCheckpoint(cp);
    }

    listCheckpoints(sessionId?: string): CheckpointRow[] {
        this.assertLive();
        return this.store.listCheckpoints(sessionId);
    }

    getCheckpoint(cpId: string): CheckpointRow | undefined {
        this.assertLive();
        return this.store.getCheckpoint(cpId);
    }

    checkpointState(cpId: string): { stateJson: string; byteLen: number } {
        this.assertLive();
        return this.store.checkpointState(cpId);
    }

    deleteCheckpoint(cpId: string): boolean {
        this.assertLive();
        return this.store.deleteCheckpoint(cpId);
    }

    /** Ingest freshness watermark for load-side import gating (null = never
     *  ingested). The agent hint pins the exact row under a shared id. See
     *  SessionStore.buildForLoadAll for the race this guards. */
    sessionUpdatedAt(sessionId: string, hint?: { agent?: string }): number | null {
        this.assertLive();
        return this.store.sessionUpdatedAt(hint?.agent ? makeSessionKey(hint.agent, sessionId) : sessionId);
    }

    /** Absolute-seq tip of the session's message log (+1 = next free seq).
     *  Used as a checkpoint's seq_at. Accepts a full opaque key or a bare id. */
    sessionTipSeq(sessionId: string): number {
        this.assertLive();
        let tip = 0;
        for (const m of this.store.getMessages(sessionId)) if (m.seq + 1 > tip) tip = m.seq + 1;
        return tip;
    }

    /** Full opaque key of the row owning `id` (bare conversation id), or
     *  null when uningested — callers that must stamp child rows (checkpoint
     *  session_id) with the exact key use this instead of guessing. */
    sessionKey(id: string, hint?: { agent?: string }): string | null {
        this.assertLive();
        const row = this.store.getSessionRow(hint?.agent ? makeSessionKey(hint.agent, id) : id);
        return row ? makeSessionKey(row.agent, row.sessionId) : null;
    }

    private assertLive(): void {
        if (this.stats.disabled) throw new Error("[storage] unified sidecar is disabled (repeated failures) — replica operations are unavailable");
    }

    close(): void {
        try {
            this.store.close();
        } catch {
            // shutdown path — never throw
        }
    }
}

function shadowDigest(view: unknown): string {
    return sha256(JSON.stringify(canonicalize(view)));
}
