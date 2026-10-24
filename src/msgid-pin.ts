// #4491 plugin-lane server history: consume + validate the client-supplied
// message-id array (`biliMsgIds`, parallel to `messages`).
//
// The ids become the messages' identity in the kernel ref space and in the
// unified table (msg_id column) — so validation is strict: an invalid array
// degrades the turn to content-derived ids rather than poisoning the ledger
// with colliding or unstable keys. Reserved prefixes stay out: `acp_summary_`
// is the kernel's synthetic-anchor namespace (rendered fold anchors carry
// those ids; a client id claiming one would misattribute decompress lookups).

import type { BiliMessage } from "acp-kernel/wire";

export const MSG_IDS_BODY_FIELD = "biliMsgIds";

const MAX_ID_LEN = 512;
const RESERVED_PREFIX = "acp_summary_";

export type MsgIdValidation = { ok: true; ids: string[] } | { ok: false; reason: string };

export function validateMsgIds(raw: unknown, expectedLen: number): MsgIdValidation {
    if (!Array.isArray(raw)) return { ok: false, reason: "not-an-array" };
    if (raw.length !== expectedLen) return { ok: false, reason: "length-mismatch" };
    const seen = new Set<string>();
    for (const v of raw) {
        if (typeof v !== "string" || v.length === 0 || v.length > MAX_ID_LEN) return { ok: false, reason: "bad-entry" };
        if (v.startsWith(RESERVED_PREFIX)) return { ok: false, reason: "reserved-prefix" };
        // whitespace/control chars make ids un-greppable and ambiguous in logs
        if (/[\s\p{C}]/u.test(v)) return { ok: false, reason: "control-or-space" };
        if (seen.has(v)) return { ok: false, reason: "duplicate" };
        seen.add(v);
    }
    return { ok: true, ids: raw as string[] };
}

export function applyMsgIdPin(msgs: BiliMessage[], ids: string[]): BiliMessage[] {
    return msgs.map((m, i) => ({ ...m, id: ids[i] }));
}
