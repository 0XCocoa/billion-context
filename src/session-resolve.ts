// #2944: order-primary session resolution on the wire-neutral domain.
//
// Owner rule (2026-10-12) — the general rule that retires the persona-fp
// ladder (#1916 → #2241 → #2250 → #2601 band-aids):
//
//   1. 顺序 + sessionid(客户端自生成、无歧义)即可认领同一个会话,绝对没有错误
//      —— 内容一个字不看。
//   2. 压缩锚点默认顺序位置,hash 只是参考(下层 #2939 order-centric reconcile
//      同向)。
//   3. hash 用于防止压缩导致的漂移、subagent 复用主会话带来的漂移 —— 防错认
//      护栏,不参与认领决策。
//   4. 不打膏药:一条通用规则,协议无关,不逐客户端特判。
//
// Substrate — the skeleton is minted from `neutralTurns()` (src/affinity-
// neutral.ts, the #2791 wire-neutral projection that #2939 already runs on),
// NOT from a raw-field classifier (that draft pattern-matched protocol
// shapes a third time — google `parts` / responses `function_call` blind,
// leading system unstripped — and was reviewed out in #2944). One source of
// protocol-shape knowledge, four wires for free:
//
//   skeletonOf(messages) = neutralTurns(messages).map(t => t.kind)
//
//   - content-blind by construction (kind ∈ user|assistant|tool|raw|<role>)
//   - google `parts` and responses `function_call` items are first-class
//   - the LEADING system/developer run is stripped — host harness churn
//     cannot misalign the skeleton (#1148 discipline)
//   - client synthetic marker turns ("[model changed: …]") are dropped
//   - image-capability placeholders (#2636) are dropped
//   - consecutive assistant messages merge, multi-block tool_results split —
//     renderers that disagree on message packing agree on turns
//
// Guard rail (rule 3) — consulted ONLY where order alone is ambiguous. Two
// branches look order-identical for different truths, and the projection's
// per-turn content fragments (`NeutralTurn.frags`, content-derived but never
// used for CLAIMING) disambiguate them without reading a byte of prose:
//
//   shorter-than-recorded + tail aligns:
//     genuine head truncation (dsh native compaction) keeps the surviving
//     tail messages VERBATIM → fragments equal → raw + re-anchor.
//     a codex-style subagent replay (#150: reuses the main body.session_id,
//     self-contained, alternating tail aligns trivially by shape) carries
//     DIFFERENT tail content → fragments differ → derived-task, never raw.
//   grown/equal + head diverged + tail aligns:
//     a compaction-summary head over the verbatim old tail passes; a
//     coincidentally tail-aligning stranger fails.
//
// Derived-task lanes are discriminated by skeleton hash
// (`|sub:task:<skel8>`): distinct stranger shapes never share one
// compression session (two subagents under one main id stay separate) while
// the same stranger replaying across passes keeps a stable key.
//
// id provenance (caller contract — effective at wiring time; ids that fail
// it stay on the anonymous ladder, prefix-affinity, untouched):
//
//   lane        qualifies (client-minted, unambiguous)    falls back
//   anthropic   header (plugin conv / session header)     first-user content fp
//   openai      header                                     first-user content fp
//   responses   header | body.session_id | metadata.session_id
//                                                       previous_response_id (upstream-minted), content fp
//   google      header                                     content fp
//
//   (axis: conversationIdentityResponses' `clientProvided` — kernel/src/wire/
//   responses.ts — and the per-wire twins; a content-fingerprint id is
//   representation-derived and never qualifies.) NOTE for the wiring PR: the
//   codex instructions-namespace (SubagentNamespaces) and the anthropic #970
//   subagent split run UPSTREAM of this resolver and stay — this module owns
//   the conversation axis only.
//
// Rollout: implemented ALONGSIDE src/persona-anchor.ts (the old fp ladder) —
// the old file is NOT deleted and the server is NOT switched over yet. Both
// implementations are pinned by the same input/output corpus in
// tests/issue2944-neutral-skeleton.test.ts (behavior-compatible rows share
// one expectation; designed divergences marked old→new). Switch-over is a
// separate small step after the differential soak.

import { createHash } from "node:crypto";
import { neutralTurns, type NeutralTurn } from "./affinity-neutral.js";

/** Tail window in TURNS (coarser than a raw-message window: one turn can be
 *  several packed messages). */
const TAIL_WINDOW = 8;

/** Order skeleton: the per-turn KIND sequence of the wire-neutral
 *  projection. Content-blind by construction — only role/tool shape
 *  participates, never prose. */
export function orderSkeletonOf(messages: unknown): string[] {
    const list = Array.isArray(messages) ? (messages as unknown[]) : [];
    return neutralTurns(list).map((t) => t.kind);
}

/** Per-turn content-fragment fingerprints (the rule-3 guard rail). Never
 *  consulted for claiming — only to disambiguate the two order-ambiguous
 *  corners below. #2791 projects the same logical content to the same
 *  fragments on every wire, so the guard is cross-wire stable. */
function tailFragsOf(turns: NeutralTurn[], window: number): string[] {
    return turns.slice(-window).map((t) => (t.frags ?? [t.kind]).join("\u0001"));
}

function tailAligns(kinds: string[], recorded: string[]): boolean {
    const window = Math.min(TAIL_WINDOW, kinds.length, recorded.length);
    if (window === 0) return false;
    for (let i = 1; i <= window; i++) {
        if (kinds[kinds.length - i] !== recorded[recorded.length - i]) return false;
    }
    return true;
}

/** A main conversation has assistant turns and at least a few of them; an
 *  aux persona (dsh auto-review: one flattened user blob) has neither. This
 *  is the ONLY aux/persona discriminator — no system text, no content hash,
 *  no per-client special case. */
function mainShaped(kinds: string[]): boolean {
    return kinds.length >= 3 && kinds.some((k) => k === "assistant");
}

/** Skeleton-hash discriminator for derived-task lanes: 8 hex of the KIND
 *  sequence (content-blind — the same shape replays stable, different
 *  shapes split). */
const skel8 = (kinds: string[]): string =>
    createHash("sha256").update(kinds.join("\u0000")).digest("hex").slice(0, 8);

export type SessionOrderResolution = {
    key: string;
    action: "claim" | "continue" | "reanchor" | "derived-aux" | "derived-task";
    /** Human-readable reason for the derived/reanchor branches (log surface). */
    reason?: string;
};

type Recorded = { kinds: string[]; tailFrags: string[] };

/** In-memory order skeletons — process memory, same lifetime as the old
 *  anchors map (not persisted; a restart re-claims on first sight). */
const skeletons = new Map<string, Recorded>();

function record(rawId: string, turns: NeutralTurn[]): void {
    skeletons.set(rawId, {
        kinds: turns.map((t) => t.kind),
        tailFrags: tailFragsOf(turns, TAIL_WINDOW),
    });
}

/** #2944 order-primary resolution. `rawId` MUST be a client-minted,
 *  unambiguous conversation id (provenance contract above; ids that fail it
 *  stay on the anonymous ladder). */
export function resolveSessionOrder(rawId: string, history: unknown): SessionOrderResolution {
    const list = Array.isArray(history) ? (history as unknown[]) : [];
    const turns = neutralTurns(list);
    const kinds = turns.map((t) => t.kind);
    const recorded = skeletons.get(rawId);
    if (recorded === undefined) {
        // First sight under the id. A main-shaped history claims the raw
        // key; anything shallower is an aux persona and NEVER claims — the
        // #1916/#2156 blob-steals-raw race dies here without reading a byte
        // of system text.
        if (!mainShaped(kinds)) {
            return { key: `${rawId}|sub:aux`, action: "derived-aux", reason: "shallow history with no assistant turns" };
        }
        record(rawId, turns);
        return { key: rawId, action: "claim" };
    }
    if (!mainShaped(kinds)) {
        // Aux traffic under an already-claimed id — always derived.
        return { key: `${rawId}|sub:aux`, action: "derived-aux", reason: "aux persona reuse of the main id" };
    }
    const incomingFrags = tailFragsOf(turns, TAIL_WINDOW);
    // Rule-3 guard: do the trailing fragments agree over the comparable
    // window? Genuine compaction keeps the old tail messages verbatim; an
    // id-reuse replay does not.
    const fragTailEquals = (n: number): boolean => {
        const w = Math.min(TAIL_WINDOW, n);
        const a = incomingFrags.slice(-w);
        const b = recorded.tailFrags.slice(-w);
        return a.length === b.length && a.every((f, i) => f === b[i]);
    };
    if (kinds.length >= recorded.kinds.length) {
        if (recorded.kinds.every((k, i) => kinds[i] === k)) {
            record(rawId, turns);
            return { key: rawId, action: "continue" };
        }
        if (tailAligns(kinds, recorded.kinds) && fragTailEquals(recorded.kinds.length)) {
            // Grown (or equal), prefix diverged, tail aligned AND fragment-
            // verified: the host rewrote the head (native-compaction summary
            // / re-anchored event log) while keeping the living tail
            // verbatim. Trust the id, re-anchor the skeleton.
            record(rawId, turns);
            return { key: rawId, action: "reanchor", reason: "order tail aligned and fragment-verified, head rewritten" };
        }
        // Deep main-shaped history sharing nothing order-wise with the
        // recorded skeleton: guard rail (rule 3) — derived, never the raw
        // key. The skeleton-hash discriminator keeps distinct strangers on
        // distinct compression sessions.
        return { key: `${rawId}|sub:task:${skel8(kinds)}`, action: "derived-task", reason: "no order+fragment alignment with the recorded skeleton" };
    }
    // Shorter than recorded: order alone cannot tell genuine head
    // truncation (native compaction — verbatim surviving tail) from a
    // self-contained id-reuse replay (#150 subagent — different tail
    // content). The fragment guard decides.
    if (tailAligns(kinds, recorded.kinds) && fragTailEquals(kinds.length)) {
        record(rawId, turns);
        return { key: rawId, action: "reanchor", reason: "truncated head, tail aligned and fragment-verified" };
    }
    return {
        key: `${rawId}|sub:task:${skel8(kinds)}`,
        action: "derived-task",
        reason: "shorter history with a divergent tail — id-reuse guard (subagent replay?)",
    };
}

/** Diagnostic/test surface: the recorded skeleton for an id. */
export function sessionOrderSkeletonOf(rawId: string): string[] | undefined {
    return skeletons.get(rawId)?.kinds;
}

export function resetSessionOrderForTest(): void {
    skeletons.clear();
}
