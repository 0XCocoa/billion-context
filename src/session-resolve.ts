// #2944: order-primary session resolution — the general rule that retires
// the persona-fp ladder (owner rule, 2026-10-12):
//
//   1. 顺序 + sessionid(客户端自生成、无歧义)就可以认领为同一个会话,
//      绝对没有错误 —— 内容一个字不看。
//   2. 压缩锚点默认顺序位置,hash 只是参考(下层 #2939 order-centric
//      reconcile 同向;PR 未合并——切换前核对其合并状态)。
//   3. hash 用来防止压缩导致的漂移、subagents 复用主会话带来的漂移
//      —— 防错认护栏,不参与认领决策。本层唯一的护栏是消息形状:
//      浅 blob(无 assistant 轮)= 辅助 persona,派生 key。
//   4. 不打膏药:一条通用规则,协议无关,不逐客户端特判。
//
// This module is the NEW implementation, implemented ALONGSIDE
// src/persona-anchor.ts (the old ladder) — the old file is NOT deleted and
// the server is NOT switched over yet (see #2944 rollout). Both
// implementations are pinned by the same input/output corpus in
// tests/issue2944-session-resolve.test.ts: behavior-compatible rows share
// one expectation; designed divergences are marked old→new per row.
//
// The claim evidence is the ORDER SKELETON — the per-position message KIND
// sequence (role + tool shape), with content completely ignored. A 50%
// mid-conversation content rewrite that keeps order and length is the SAME
// session (#2917/#2821/#2847 family: representation churn must never fork
// the main lane off its folds). The id must be client-minted and
// unambiguous (never reused across conversations) — that is the caller's
// provenance contract; ids that fail it stay on the anonymous ladder
// (prefix-affinity), which is untouched.

/** Message-kind classification for the order skeleton. Content-blind by
 *  construction: only role and block shape participate. */
export function orderKindOf(msg: unknown): string {
    if (msg === null || typeof msg !== "object") return "opaque";
    const m = msg as Record<string, unknown>;
    const role = typeof m.role === "string" ? m.role : "?";
    // Tool turns are their own skeleton cell: a tool_use/tool_call and its
    // tool_result keep distinct kinds so alternating tool exchanges align
    // as tool cells, not prose cells.
    const content = m.content;
    if (Array.isArray(content)) {
        const types = content
            .map((b) => (b !== null && typeof b === "object" && typeof (b as Record<string, unknown>).type === "string" ? ((b as Record<string, unknown>).type as string) : ""))
            .filter((s: string) => s.length > 0)
            .join(",");
        if (types.length > 0) return `${role}:${types}`;
    }
    if (typeof m.tool_calls === "object" && m.tool_calls !== null) return `${role}:tool_calls`;
    if (typeof m.tool_call_id === "string") return `${role}:tool_result`;
    return role;
}

export function orderKindsOf(history: unknown): string[] {
    const list = Array.isArray(history) ? history : [];
    return list.map(orderKindOf);
}

function mainShaped(kinds: string[]): boolean {
    // A main conversation has assistant turns and at least a few cells;
    // an aux persona (dsh auto-review: one flattened user blob) has
    // neither. This is the ONLY aux/persona discriminator — no system
    // text, no content hash.
    if (kinds.length < 3) return false;
    return kinds.some((k) => k.startsWith("assistant"));
}

const AUX_MIN_TAIL = 8;

function tailAligns(kinds: string[], recorded: string[]): boolean {
    const window = Math.min(AUX_MIN_TAIL, kinds.length, recorded.length);
    if (window === 0) return false;
    for (let i = 1; i <= window; i++) {
        if (kinds[kinds.length - i] !== recorded[recorded.length - i]) return false;
    }
    return true;
}

export type SessionOrderResolution = {
    key: string;
    action: "claim" | "continue" | "reanchor" | "derived-aux" | "derived-task";
    /** Human-readable reason for the derived/reanchor branches (log surface). */
    reason?: string;
};

/** In-memory order skeletons, same lifetime as the old anchors map. */
const skeletons = new Map<string, string[]>();

/** #2944 order-primary resolution. `rawId` MUST be a client-minted,
 *  unambiguous conversation id (caller's provenance contract). */
export function resolveSessionOrder(rawId: string, history: unknown): SessionOrderResolution {
    const kinds = orderKindsOf(history);
    const recorded = skeletons.get(rawId);
    if (recorded === undefined) {
        // First sight under the id. A main-shaped history claims the raw
        // key; anything else (shallow blob with no assistant turns) is an
        // aux persona and NEVER claims — the #1916 review-steals-raw race
        // dies here without reading a byte of system text.
        if (!mainShaped(kinds)) {
            return { key: `${rawId}|sub:aux`, action: "derived-aux", reason: "shallow history with no assistant turns" };
        }
        skeletons.set(rawId, kinds);
        return { key: rawId, action: "claim" };
    }
    if (!mainShaped(kinds)) {
        // Aux traffic under an already-claimed id — always derived.
        return { key: `${rawId}|sub:aux`, action: "derived-aux", reason: "aux persona reuse of the main id" };
    }
    if (kinds.length >= recorded.length) {
        const aligns = recorded.every((k, i) => kinds[i] === k);
        if (aligns) {
            skeletons.set(rawId, kinds);
            return { key: rawId, action: "continue" };
        }
        if (tailAligns(kinds, recorded)) {
            // Same length or grown, prefix diverged, tail aligned: the host
            // rewrote the head (native compaction summary / re-anchored
            // event log). Trust the id, re-anchor the skeleton.
            skeletons.set(rawId, kinds);
            return { key: rawId, action: "reanchor", reason: "order tail aligned, head rewritten" };
        }
        // Deep main-shaped history sharing nothing with the recorded
        // skeleton on an unambiguous id: the guard rail (owner rule 3) —
        // derived, never the raw key, until the skeleton is re-established.
        return { key: `${rawId}|sub:task`, action: "derived-task", reason: "no order alignment with the recorded skeleton" };
    }
    // Shorter than recorded: head truncation (dsh native compaction). The
    // tail is the living end of the conversation — tail alignment keeps the
    // raw key and re-anchors; even without it the id is unambiguous, so the
    // conversation stays raw and the skeleton follows the host's truth.
    skeletons.set(rawId, kinds);
    return { key: rawId, action: "reanchor", reason: tailAligns(kinds, recorded) ? "truncated head, tail aligned" : "truncated head, id trusted" };
}

/** Diagnostic/test surface: the recorded skeleton for an id. */
export function sessionOrderSkeletonOf(rawId: string): string[] | undefined {
    return skeletons.get(rawId);
}

export function resetSessionOrderForTest(): void {
    skeletons.clear();
}
