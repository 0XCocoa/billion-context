/**
 * Negotiated conversation recall (#4082, #3918, #2975).
 *
 * The native lanes attribute a model request to a host session by reading the
 * host's execution context (AsyncLocalStorage initiator). That context is
 * MISSING on the paths the host drives outside an agent turn — quota/429
 * retries, model switches, and post-resume resends — so those dispatches fall
 * out of the takeover gate into raw DIRECT sends: compression off, guards
 * off, and (because the host keeps growing the same conversation) the damage
 * is permanent for that session (#3918).
 *
 * This module is the fallback identity: while attribution WORKS, the shim
 * learns `lane → (session id, boundary fingerprint)` — the boundary is the
 * fingerprint of the LAST message of the attributed request's body. When
 * attribution is later missing on the same lane, a dispatch whose history
 * CONTAINS a remembered boundary is provably that session's continuation
 * (retries and model switches resend the identical history; that is the
 * problem AND the proof), and the gate can claim it again with the server's
 * own session id.
 *
 * Safety rules:
 *  - The boundary must be CONTAINED in the incoming history and the match
 *    must be UNIQUE across the lane's remembered sessions — otherwise no
 *    stamp (behavior stays exactly today's direct send). Never guess.
 *  - A fork that diverges from mid-history does not contain the parent's
 *    latest boundary → never claimed. Only a fork copied from the very END is
 *    physically indistinguishable from a continuation; the TTL window plus
 *    reconcile drift isolation bound that rare² case (and #2399 adoption
 *    semantics make even it semantically sound).
 *  - Entries expire (RECALL_TTL_MS) and each lane keeps at most
 *    RECALL_PER_LANE sessions (LRU) — retries happen within seconds of the
 *    original dispatch, this is a short-window bridge, not a registry.
 */
import { createHash } from "node:crypto";

const RECALL_TTL_MS = 10 * 60_000;
const RECALL_PER_LANE = 8;
const RECALL_MAX_LANES = 64;

type ConversationRecallStats = {
    lanes: number;
    sessions: number;
    learned: number;
    recalled: number;
    rejectedNoLane: number;
    rejectedNoBoundary: number;
    rejectedAmbiguous: number;
    expired: number;
};

type LaneEntry = { sid: string; boundaryFp: string; at: number };

const lanes = new Map<string, Map<string, LaneEntry>>();
const stats: ConversationRecallStats = {
    lanes: 0,
    sessions: 0,
    learned: 0,
    recalled: 0,
    rejectedNoLane: 0,
    rejectedNoBoundary: 0,
    rejectedAmbiguous: 0,
    expired: 0,
};

function sweep(now: number): void {
    for (const [laneKey, perLane] of lanes) {
        for (const [sid, entry] of perLane) {
            if (now - entry.at > RECALL_TTL_MS) {
                perLane.delete(sid);
                stats.expired++;
            }
        }
        if (perLane.size === 0) lanes.delete(laneKey);
    }
    while (lanes.size > RECALL_MAX_LANES) {
        // Simple bound: drop the least recently updated lane.
        let oldestKey: string | undefined;
        let oldestAt = Infinity;
        for (const [laneKey, perLane] of lanes) {
            for (const entry of perLane.values()) {
                if (entry.at < oldestAt) {
                    oldestAt = entry.at;
                    oldestKey = laneKey;
                }
            }
        }
        if (oldestKey === undefined) break;
        lanes.delete(oldestKey);
    }
    stats.lanes = lanes.size;
    stats.sessions = [...lanes.values()].reduce((n, perLane) => n + perLane.size, 0);
}

/**
 * Lane key: endpoint (origin + path — query strings can carry per-request
 * noise) plus the authorization header's fingerprint when present. Two API
 * keys on the same endpoint are different lanes; the same key across a model
 * switch is ONE lane (the model field changes, the history does not — that is
 * the #3918 case this must catch).
 */
export function recallLaneKey(url: string): string {
    const u = new URL(url);
    // Deliberately NO authorization component and NO model: auth tokens
    // rotate (bearer refresh, key swap — an orphaned lane would break the
    // bridge on the exact retry it exists for), and #3918's model switch is
    // the shape we must recognize. The lane is only the search namespace;
    // identity evidence is the boundary fingerprint plus its uniqueness.
    return `${u.origin}${u.pathname}`;
}

/** Stable fingerprint of one wire message (byte-stable: hosts serialize
 * deterministically, and a retry resends the identical serialization). */
function recallFingerprintOfMessage(message: unknown): string | undefined {
    if (typeof message !== "object" || message === null) return undefined;
    const role = (message as { role?: unknown }).role;
    const content = (message as { content?: unknown }).content;
    if (typeof role !== "string" || (content !== undefined && typeof content !== "string" && typeof content !== "object")) {
        return undefined;
    }
    try {
        return createHash("sha256").update(JSON.stringify({ role, content })).digest("hex").slice(0, 24);
    } catch {
        return undefined;
    }
}

/** Fingerprints of every message in a wire `messages` array. */
export function recallHistoryFingerprints(messages: unknown): Set<string> {
    const out = new Set<string>();
    if (!Array.isArray(messages)) return out;
    for (const m of messages) {
        const fp = recallFingerprintOfMessage(m);
        if (fp !== undefined) out.add(fp);
    }
    return out;
}

/** The boundary fingerprint of a body: its LAST message. */
export function recallBoundaryOfMessages(messages: unknown): string | undefined {
    if (!Array.isArray(messages) || messages.length === 0) return undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
        const fp = recallFingerprintOfMessage(messages[i]);
        if (fp !== undefined) return fp;
    }
    return undefined;
}

/** Learn (attribution ok): this session's latest dispatch boundary on this lane. */
export function learnConversation(laneKey: string, sid: string, boundaryFp: string): void {
    const now = Date.now();
    sweep(now);
    let perLane = lanes.get(laneKey);
    if (perLane === undefined) {
        perLane = new Map();
        lanes.set(laneKey, perLane);
    }
    // LRU touch + TTL refresh.
    perLane.delete(sid);
    while (perLane.size >= RECALL_PER_LANE) {
        let oldestSid: string | undefined;
        let oldestAt = Infinity;
        for (const [s, e] of perLane) {
            if (e.at < oldestAt) {
                oldestAt = e.at;
                oldestSid = s;
            }
        }
        if (oldestSid === undefined) break;
        perLane.delete(oldestSid);
    }
    perLane.set(sid, { sid, boundaryFp, at: now });
    stats.learned++;
    stats.lanes = lanes.size;
    stats.sessions = [...lanes.values()].reduce((n, l) => n + l.size, 0);
}

/**
 * Recall (attribution missing): the UNIQUE remembered session on this lane
 * whose boundary fingerprint is contained in the incoming history. Undefined
 * = no evidence, keep today's behavior.
 */
export function recallConversation(laneKey: string, historyFps: Set<string>): string | undefined {
    const now = Date.now();
    sweep(now);
    const perLane = lanes.get(laneKey);
    if (perLane === undefined || perLane.size === 0) {
        stats.rejectedNoLane++;
        return undefined;
    }
    const hits: string[] = [];
    for (const entry of perLane.values()) {
        if (historyFps.has(entry.boundaryFp)) hits.push(entry.sid);
    }
    if (hits.length === 0) {
        stats.rejectedNoBoundary++;
        return undefined;
    }
    if (hits.length > 1) {
        stats.rejectedAmbiguous++;
        return undefined;
    }
    // LRU touch so an active session survives idle siblings.
    const entry = perLane.get(hits[0]);
    if (entry !== undefined) {
        perLane.delete(hits[0]);
        entry.at = now;
        perLane.set(hits[0], entry);
    }
    stats.recalled++;
    return hits[0];
}

export function conversationRecallStats(): Readonly<ConversationRecallStats> {
    return { ...stats };
}

export function __resetConversationRecallForTests(): void {
    lanes.clear();
    stats.lanes = 0;
    stats.sessions = 0;
    stats.learned = 0;
    stats.recalled = 0;
    stats.rejectedNoLane = 0;
    stats.rejectedNoBoundary = 0;
    stats.rejectedAmbiguous = 0;
    stats.expired = 0;
}

/** Test seam: age every entry by the given ms (TTL expiry scenarios). */
export function __ageConversationRecallForTests(ms: number): void {
    for (const perLane of lanes.values()) {
        for (const entry of perLane.values()) entry.at -= ms;
    }
}
