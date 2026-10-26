import type { CoreMessage } from "acp-kernel";
import type { Session } from "./session.js";

// #4805: settle-side membership gate. A usage report is only "this
// conversation's truth" when the request that produced it actually carried
// this conversation's messages. Hosts stamp auxiliary personas (dsh
// auto-review and its relatives) with the SAME conversation id, so the
// session key alone cannot tell a main-turn report from a foreign
// 2-message one — but the message ids can: a main turn resends history the
// session already knows, while an auxiliary payload brings ids the session
// has never seen. Evidence is id-based ONLY (no content hashing — host ids
// are stable per-lane observation; content joins stay with fold-reconcile):
//   - plugin lanes: the biliMsgIds envelope the host stamps alongside the
//     message array (#4491), read regardless of the pin rollout state;
//   - every wire: the tool-call ids resent in the history (model-minted,
//     client-echoed — the only ids the raw protocol wires carry).
// The verdict abstains (never gates) when evidence is thin: first turns,
// tool-less sidecars, or the #2821 id re-mint family — a re-minted main
// turn loses at most ONE anchor update and self-heals on the next resend
// (its ids then join the known family).
export const MEMBERSHIP_HISTORY_CAP = 4000;
export const MEMBERSHIP_MIN_KNOWN_IDS = 8;
export const MEMBERSHIP_MIN_REQUEST_IDS = 4;
export const MEMBERSHIP_MIN_OVERLAP_RATIO = 0.25;
// #2821 tiebreak: a main turn whose ids were ALL re-minted reads as foreign
// too — but unlike an auxiliary persona it carries main-scale payload. Only
// at-conversation-scale requests may join the known family on a zero-overlap
// verdict, so the re-mint heals on its second resend while a tiny polluter
// (payload ~1% of the anchor) never graduates.
export const MEMBERSHIP_RECORD_SCALE_RATIO = 0.25;

export type RequestMembership = { overlap: number; total: number; known: number };

export function collectRequestIds(envelopeIds: unknown, msgs: CoreMessage[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    if (Array.isArray(envelopeIds)) {
        for (const v of envelopeIds) {
            if (typeof v === "string" && v.length > 0 && v.length <= 512 && !v.startsWith("acp_summary_") && !seen.has(v)) {
                seen.add(v);
                out.push(v);
            }
        }
        if (out.length > 0) return out;
    }
    for (const m of msgs) {
        const id = m.toolCallId;
        if (typeof id === "string" && id.length > 0 && !seen.has(id)) {
            seen.add(id);
            out.push(id);
        }
    }
    return out;
}

export function isForeignMembership(m: RequestMembership | null | undefined): boolean {
    if (!m) return false;
    return m.known >= MEMBERSHIP_MIN_KNOWN_IDS && m.total >= MEMBERSHIP_MIN_REQUEST_IDS && m.overlap < m.total * MEMBERSHIP_MIN_OVERLAP_RATIO;
}

export function classifyAndRecordMembership(session: Session, ids: string[], payloadUpper: number): RequestMembership | null {
    if (ids.length === 0) return null;
    const t = session.transient;
    if (!t) return null;
    const known = new Set(t.knownMessageIds);
    let overlap = 0;
    for (const id of ids) if (known.has(id)) overlap++;
    const verdict: RequestMembership = { overlap, total: ids.length, known: known.size };
    t.requestMembership = verdict;
    // Only admitted, evidence-poor, or main-scale requests teach the session
    // its id family — a tiny foreign payload's ids must never enter the known
    // set, or a persistent auxiliary persona would graduate to "member" on
    // its second visit and reopen #4805 through the front door.
    const mainScale = session.stats.lastInputTokens <= 0 || payloadUpper >= session.stats.lastInputTokens * MEMBERSHIP_RECORD_SCALE_RATIO;
    if (!isForeignMembership(verdict) || mainScale) {
        for (const id of ids) known.add(id);
        const all = [...known];
        t.knownMessageIds = all.length > MEMBERSHIP_HISTORY_CAP ? all.slice(all.length - MEMBERSHIP_HISTORY_CAP) : all;
    }
    return verdict;
}
