/**
 * #2960 (R2): the unified store's session identity is the PAIR
 * (agent namespace, conversation id) — never protocol/host/origin. Those are
 * mutable metadata columns on the same row: switching provider/wire/model
 * mid-conversation (same agent, same conversation id) keeps ONE row and the
 * fold ledger follows in place (#2847 / #2671 defect-1).
 *
 * The pair is carried two ways, by design:
 *   - the sessions table decomposes it into real columns: PRIMARY KEY (agent, conv_id);
 *   - every child row (messages/blocks/dead_refs/refs/ccr_entries/checkpoints) carries the
 *     OPAQUE COMPOSITE `makeSessionKey(agent, convId)` in its session_id column, so child
 *     rows stay unambiguous when two agents share one conversation value and no child
 *     table needs a second key column.
 *
 * Composite keys are ESCAPED strings, not raw concatenations: both halves may
 * contain any character hosts mint (ids are opaque), so `\` escapes itself and
 * the separator. NULs are lossy-replaced because node:sqlite truncates bound
 * strings at NUL (engine parity: better-sqlite3 keeps them, node:sqlite does
 * not — the escaped form must survive BOTH).
 *
 * Ids are opaque strings, never interpreted (issue design objection 2): the only per-host
 * properties relied on are stability within a conversation and uniqueness within a host;
 * cross-host collision is blocked by the namespace column.
 */

/** Namespace for sessions with no resolvable client identity (pre-#1426 records, etc.). */
export const ANON_AGENT = "anon";

/** Cap matching anon-provenance.ts's pluginAgent cap — namespaces stay short log-safe strings. */
const AGENT_MAX_LEN = 64;

const NUL_REPLACE = "\uFFFD";

/** Unescaped separator inside composite keys. */
export const SESSION_KEY_SEP = "|";

/** Normalize one side of the key: trim, NUL-proof, length-capped. Deterministic. */
export function normalizeKeyPart(part: string): string {
    const cleaned = part.replace(/\u0000/g, NUL_REPLACE).trim();
    return cleaned.length > AGENT_MAX_LEN ? cleaned.slice(0, AGENT_MAX_LEN) : cleaned;
}

/**
 * Resolve the agent namespace from persisted session metadata — the same
 * resolver the web UI displays with (web/sessions-data.ts: pluginAgent first,
 * then clientHint). Both fields are request-time facts that do NOT depend on
 * protocol/host/origin, which is exactly why they may sit in the key while
 * protocol/host may not. Absent metadata → "anon".
 */
export function resolveAgentNamespace(metadata?: Record<string, unknown> | null): string {
    if (metadata && typeof metadata === "object") {
        const pa = metadata["pluginAgent"];
        if (typeof pa === "string" && pa.trim() !== "") return normalizeKeyPart(pa);
        const hint = metadata["clientHint"];
        if (typeof hint === "string" && hint.trim() !== "") return normalizeKeyPart(hint);
    }
    return ANON_AGENT;
}

function escapeKeyPart(part: string): string {
    return part.replace(/\u0000/g, NUL_REPLACE).replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

function unescapeKeyPart(part: string): string {
    return part.replace(/\\\|/g, SESSION_KEY_SEP).replace(/\\\\/g, "\\");
}

/** Composite opaque key for child-table session_id columns. Injective in both halves. */
export function makeSessionKey(agent: string, convId: string): string {
    return `${escapeKeyPart(normalizeKeyPart(agent))}${SESSION_KEY_SEP}${escapeKeyPart(convId)}`;
}

export interface ParsedSessionKey { agent: string; convId: string }

/** True when the value contains an UNESCAPED separator (i.e. it is a composite key, not a bare id). */
export function isSessionKey(value: string): boolean {
    for (let i = 0; i < value.length; i++) {
        if (value[i] === SESSION_KEY_SEP) return i === 0 || value[i - 1] !== "\\";
    }
    return false;
}

/**
 * Split a composite key back into (agent, convId). A value WITHOUT an unescaped
 * separator is a bare conversation id: it parses to (anon, value) so old-format
 * values read back sanely instead of crashing any display surface.
 */
export function parseSessionKey(key: string): ParsedSessionKey {
    for (let i = 0; i < key.length; i++) {
        if (key[i] === SESSION_KEY_SEP && (i === 0 || key[i - 1] !== "\\")) {
            return { agent: unescapeKeyPart(key.slice(0, i)), convId: unescapeKeyPart(key.slice(i + 1)) };
        }
    }
    return { agent: ANON_AGENT, convId: key };
}
