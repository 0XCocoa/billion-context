// #2944 v2: order-primary session resolution — on the WIRE-NEUTRAL domain.
//
// The general rule that retires the persona-fp ladder (owner rule,
// 2026-10-12):
//
//   1. 顺序 + sessionid(客户端自生成、无歧义)即可认领同一个会话,
//      绝对没有错误 —— 内容一个字不看。
//   2. 压缩锚点默认顺序位置,hash 只是参考(下层 #2939 order-centric
//      reconcile 同向)。
//   3. hash 用于防止压缩导致的漂移、subagent 复用主会话带来的漂移
//      —— 防错认护栏,不参与认领决策。
//   4. 不打膏药:一条通用规则,协议无关,不逐客户端特判。
//
// v2 substrate (the delta vs the first draft, see #2944 review): the
// skeleton is minted from `neutralTurns()` (src/affinity-neutral.ts, the
// #2791 wire-neutral projection that #2939 already runs on) — NOT from a
// new raw-field classifier. One source of protocol-shape knowledge, all
// four wires for free:
//
//   skeletonOf(messages) = neutralTurns(messages).map(t => t.kind)
//
//   - content-blind by construction (kind ∈ user|assistant|tool|raw|role)
//   - google `parts` and responses `function_call` items are first-class
//   - the LEADING system/developer run is stripped (host harness state
//     churn cannot misalign the skeleton — #1148 discipline)
//   - client synthetic marker turns ("[model changed: …]") are dropped
//   - image-capability placeholders (#2636) are dropped
//   - consecutive assistant messages merge, multi-block tool_results
//     split — so renderers that disagree on message packing agree on turns
//
// Guard rail (rule 3) — where ORDER alone is ambiguous. Two branches look
// order-identical for different truths, and content-fragment hashes (the
// projection's per-turn `frags`, content-derived but never consulted for
// CLAIMING) disambiguate without reading a byte of prose:
//
//   shorter-than-recorded + tail aligns:
//     genuine head truncation (dsh native compaction) keeps the old tail
//     MESSAGES verbatim → tail frags equal → raw + reanchor.
//     a codex-style subagent replay (#150: reuses the main
//     body.session_id, self-contained, alternating tail aligns easily)
//     carries DIFFERENT tail content → frags differ → derived, never raw.
//   grown + head diverged + tail aligns (head rewritten by a compaction
//     summary): same frag check — a summary head with the old tail passes;
//     a coincidentally tail-aligning stranger fails.
//
// Derived-task lanes are DISCRIMINATED by skeleton hash
// (`|sub:task:<skel8>`): different stranger shapes never share one
// compression session (two subagents under one main id stay separate),
// while the same stranger replaying across passes keeps a stable key.
//
// id provenance (接线时生效 — the caller contract; ids that fail it stay
// on the anonymous ladder, prefix-affinity, untouched):
//
//   lane        qualifies (client-minted, unambiguous)   falls back
//   anthropic   header (plugin conv / session header)    first-user content fp
//   openai      header                                    first-user content fp
//   responses   header | body.session_id | metadata.session_id
//                                                        previous_response_id (upstream-minted), content fp
//   google      header                                    content fp
//
//   (derived from conversationIdentityResponses' `clientProvided` axis —
//   kernel/src/wire/responses.ts — and the per-wire twins; a
//   content-fingerprint id is representation-derived and never qualifies.
//   NOTE for the wiring PR: the codex instructions-namespace
//   (SubagentNamespaces) and the anthropic #970 subagent split run
//   UPSTREAM of this resolver and stay — this module is the conversation
//   axis only.)
//
// This module is the NEW implementation, implemented ALONGSIDE
// src/persona-anchor.ts (the old ladder) — the old file is NOT deleted and
// the server is NOT switched over yet (see #2944 rollout). Both
// implementations are pinned by the same input/output corpus in
// tests/issue2944-neutral-skeleton.test.ts: behavior-compatible rows share
// one expectation; designed divergences are marked old→new per row.

import { createHash } from "node:crypto";
import { neutralTurns, type NeutralTurn } from "./affinity-neutral.js";

const TAIL_WINDOW = 8;

/** Order skeleton: the per-turn KIND sequence of the wire-neutral
 *  projection. Content-blind by construction — only role/tool shape
 *  participates. */
export function orderSkeletonOf(messages: unknown): string[] {
    const list = Array.isArray(messages) ? (messages as unknown[]) : [];
    return neutralTurns(list).map((t) => t.kind);
}

/** Per-turn content-fragment fingerprints (rule-3 guard rail — never
 *  consulted for claiming, only to disambiguate order-ambiguous corners).
 *  #2791 projects the same logical content to the same fragments on every
 *  wire, so the guard is cross-wire stable. */
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

/** A main conversation has assistant turns and at least a few cells; an
 *  aux persona (dsh auto-review: one flattened user blob) has neither.
 *  This is the ONLY aux/persona discriminator — no system text, no content
 *  hash, no per-client special case. */
function mainShaped(kinds: string[]): boolean {
    if (kinds.length < 3) return false;
    return kinds.some((k) => k === "assistant");
}

const skel8 = (kinds: string[]): string =>
    createHash("sha256").update(kinds.join("\u0000")).digest("hex").slice(0, 8);

export type SessionOrderResolution = {
    key: string;
    action: "claim" | "continue" | "reanchor" | "derived-aux" | "derived-task";
    /** Human-readable reason for the derived/reanchor branches (log surface). */
    reason?: string;
};

type Recorded = { kinds: string[]; tailFrags: string[] };

/** In-memory order skeletons, same lifetime as the old anchors map
 *  (process memory; not persisted — a restart re-claims on first sight). */
const skeletons = new Map<string, Recorded>();

function record(rawId: string, turns: NeutralTurn[]): void {
    const kinds = turns.map((t) => t.kind);
    skeletons.set(rawId, { kinds, tailFrags: tailFragsOf(turns, TAIL_WINDOW) });
}

/** #2944 order-primary resolution. `rawId` MUST be a client-minted,
 *  unambiguous conversation id (caller's provenance contract — see the
 *  table above; ids that fail it stay on the anonymous ladder). */
export function resolveSessionOrder(rawId: string, history: unknown): SessionOrderResolution {
    const list = Array.isArray(history) ? (history as unknown[]) : [];
    const turns = neutralTurns(list);
    const kinds = turns.map((t) => t.kind);
    const incomingFrags = tailFragsOf(turns, TAIL_WINDOW);
    const recorded = skeletons.get(rawId);
    if (recorded === undefined) {
        // First sight under the id. A main-shaped history claims the raw
        // key; anything else (shallow blob with no assistant turns) is an
        // aux persona and NEVER claims — the #1916 review-steals-raw race
        // dies here without reading a byte of system text.
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
        if (tailAligns(kinds, recorded.kinds) && fragTailEquals(Math.min(kinds.length, recorded.kinds.length))) {
            // Grown (or equal), prefix diverged, tail aligned AND the tail
            // fragments match: the host rewrote the head (native compaction
            // summary / re-anchored event log) while keeping the living
            // tail verbatim. Trust the id, re-anchor the skeleton.
            record(rawId, turns);
            return { key: rawId, action: "reanchor", reason: "order tail aligned and tail fragments match, head rewritten" };
        }
        // Deep main-shaped history sharing nothing with the recorded
        // skeleton on an unambiguous id: the guard rail (owner rule 3) —
        // derived, never the raw key, until the skeleton is re-established.
        // The skeleton-hash discriminator keeps distinct strangers (two
        // subagents under one main id) on distinct compression sessions.
        return { key: `${rawId}|sub:task:${skel8(kinds)}`, action: "derived-task", reason: "no order+fragment alignment with the recorded skeleton" };
    }
    // Shorter than recorded: either head truncation (dsh native compaction
    // keeps the old tail messages verbatim → fragments equal → raw +
    // re-anchor, the living end follows the host's truth) or an id-reuse
    // replay (#150 codex subagent: self-contained, tail aligns by
    // alternation) whose tail content is DIFFERENT → derived-task.
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
