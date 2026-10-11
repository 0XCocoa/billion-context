import { createHash } from "node:crypto";
import { hammingHex, sketchForCanonical } from "./affinity-simhash.js";
import { USER_IMAGE_PLACEHOLDER, normalizeMessageText } from "./fold-reconcile.js";

/**
 * Anonymous prefix-affinity session resolution (#309, replaces the #286
 * content-fingerprint 400 for clients that cannot send any identity).
 *
 * Stateless clients (dsh web, third-party harnesses) replay their FULL
 * conversation history on every request. That replay itself is a stable
 * identity signal: hash the message list into an append-only chain
 * (h_i = sha256(h_{i-1} || msg_i)) and resolve the request to the session
 * whose stored chain is the LONGEST strict prefix of the incoming chain.
 *
 * This mirrors vLLM/SGLang radix prefix caching, lifted from KV-block reuse
 * to the identity layer. The crucial difference from the removed
 * content-fingerprint (#286 hashed the FIRST user message — a permanent
 * collision anchor): a prefix match degrades gracefully — two conversations
 * sharing an opening only share a session until they diverge, then the
 * divergent request no longer matches the stored chain and forks into its
 * own session (self-healing, at most one transient merged turn).
 *
 * Semantics that cannot be avoided without client ids: a fork (edited or
 * diverged history sharing a prefix) rejoins the session of the branch that
 * most recently extended it. Two truly distinct conversations merge only
 * while byte-identical.
 *
 * Partitioning — deliberately absent (#286 lesson): protocol, upstream
 * origin and credentials are all MUTABLE MID-CONVERSATION (bearer rotation,
 * relay switching, protocol-translating relays). Partitioning by them orphans
 * state exactly when the user keeps talking. The content chain is the only
 * immutable anchor: the same person switching keys or relays mid-conversation
 * keeps the session, which is the correct semantics.
 *
 * Matching is HEAD-ANCHORED ONLY. A client that TRUNCATED its replayed
 * history does not reattach the stored chain — it forks into a fresh session
 * (birth attributed via lineage, see resolve step 2). The former
 * "tail-window reattach" (#316) adopted sessions on a contiguous MID-CHAIN
 * match, which is symmetric evidence: it cannot distinguish "same
 * conversation, truncated replay" from "a different conversation quoting
 * shared content" (templated tool outputs, standard files, stock errors —
 * parallel agents on one codebase produce these naturally). Removed in
 * #1115; rejected alternatives are documented in SESSION-IDENTITY.md.
 *
 * Safety: matching a stored chain requires holding a byte-identical HEAD, so
 * the folded state reveals nothing the requester does not already hold.
 */

/** Creation/match floor on the canonical size of the hashed messages.
 *  Excludes degenerate probes (empty / system-only requests) that carry no
 *  usable conversation signal. Below it the request keeps the #286 400. */
const MIN_CANONICAL_BYTES = 24;

/** Upper bound on tracked chains (LRU-evicted, global — content is the
 *  only key, so there are no per-credential buckets). Chains are PERMANENT
 *  (#1724): the product promise is month- to year-level single sessions, so
 *  validity never expires with time — a chain leaves the table only under
 *  capacity pressure (least-recently-used first). 1024 × ≤128 hashes ≈ 8MB
 *  worst case; typical chains are far shallower. Still exported so the
 *  persistence layer (#499 P1a / #1724) can enforce the same bound on the
 *  on-disk snapshot it writes back. */
export const MAX_TRACKED_SESSIONS = 1024;

/** Leading-run length used to attribute a NEW anonymous session's birth to a
 *  truncated replay of a tracked chain (#1115: lineage attribution ONLY —
 *  never affects matching). */
const TRUNCATION_LINEAGE_WINDOW = 8;

/** Per tracked chain, store at most this many per-item hashes (the trailing
 *  ones). Bounds memory (1024 chains × 128 × 64B ≈ 8MB) and keeps lineage
 *  lookups (fork-LCP + truncated-run, both ≤ 8 items) comfortably available.
 *  Chains deeper than this lose their head, so fork-lineage LCP detection
 *  degrades to "unknown" rather than guessing. */
const MAX_STORED_ITEMS = 128;

/** Minimum shared prefix (items) to record a "forked" lineage on a new
 *  session. UI/debug only — never used for matching. */
const MIN_FORK_PREFIX = 3;

/** #1486: minimum parent-chain depth (messages) before a byte-exact full-
 *  prefix match counts as resume evidence. A progressive sha256 chain of
 *  eight or more identical messages cannot coincide by accident (templated
 *  openings share far less); shorter chains are too common to trust. */
const MIN_RESUME_PREFIX = 8;

export interface AnonymousAffinity {
    /** Stable session id: "pfa-" + short hash of (tail, depth). */
    sessionId: string;
    /** Depth of the matched stored chain; 0 when this request creates the session. */
    matchedDepth: number;
    /** Depth of the stored chain that was matched (== matchedDepth when hit). */
    storedDepth: number;
    /** Incoming message count. */
    incomingDepth: number;
    /** Chain hash of the incoming tail (log correlation). */
    tailHash: string;
    /** How the session was resolved: a full-prefix match, a brand-new
     *  session, or (#2265) a simhash chain-alignment adoption — the incoming
     *  history is a near-similar rewrite of the stored chain (client-side
     *  decorative mutation, e.g. Trae re-stamping model tags on a model
     *  switch), so the existing session and its fold state are kept.
     *  (Truncated replays no longer reattach — #1115.) */
    via: "prefix" | "new" | "simhash";
    /** Per-item hashes of the incoming (trailing, capped at MAX_STORED_ITEMS) —
     *  passed to note() so the tracked chain can serve fork-lineage lookups. */
    itemHashes: string[];
    /** #2265: per-position simhash sketches of the incoming list (full
     *  depth, head-anchored) — the server forwards them to note() so the
     *  adoption rung has current sketches on every outcome, including the
     *  exact-prefix fast path (an entry noted without sketches would lose
     *  adoption eligibility on its next request). */
    sketches?: string[];
    /** #2265: per-position user-role flags of the incoming (trailing,
     *  MAX_STORED_ITEMS) — the ownership-anchor gate requires a byte-identical
     *  USER message for adoption (user words are the conversation's
     *  fingerprint; harness machinery is not). */
    userFlags?: boolean[];
    /** #2265: alignment statistics when via === "simhash" (observability). */
    adoption?: { coverage: number; meanHamming: number };
    /** Lineage for a NEW session: the discarded match candidates and why they
     *  were abandoned. Recorded for UI/debug only — NEVER used for matching. */
    lineage?: { parents: string[]; reason: "truncated" | "forked"; sharedPrefix?: number };
    /** #2791: IDENTIFIED session ids whose #2601 normalized tail fingerprint
     *  matches this request even though the byte chain diverged — the shape of
     *  a conversation replayed ANONYMOUSLY under a re-serialization the exact
     *  ladder cannot see (e.g. dsh switching the profile's wire protocol: every
     *  message changes shape, so chainHashes/itemHashes diverge from position 0
     *  and fork-lineage LCP is 0). Diagnostics ONLY: #1486 stands, the
     *  anonymous world never adopts an identified session — this field exists
     *  so the server can WARN that the identified conversation just lost its
     *  client to an anonymous fork (orphaned fold ledger, silent re-fold
     *  downstream) instead of the loss being fully silent. */
    orphanSuspect?: string[];
}

/** #2265 simhash-adoption policy. Second rung of the identity ladder: run
 *  only when the exact chain (step 1) did NOT match, i.e. right before a
 *  re-mint that would orphan the session's fold state. */
/** Per-position Hamming gates: ≤ SIMILAR counts toward coverage; > DIVERGENT
 *  (a completely different message anywhere) fails the whole candidate. */
const ALIGN_SIMILAR_HAMMING = 10;
const ALIGN_DIVERGENT_HAMMING = 32;
/** Fraction of aligned positions that must be SIMILAR for adoption. */
const ALIGN_COVERAGE_MIN = 0.9;
/** #629 separation guard: a rewrite is PERVASIVE (most positions mutated,
 *  e.g. a model tag re-stamped on every assistant message); an edit-fork is
 *  POINT (one or two messages edited, everything else byte-identical). Both
 *  pass the coverage gate — same per-position Hamming — but only the former
 *  is a client-side decorative rewrite. Requiring a minimum fraction of
 *  MUTATED-but-similar positions keeps edit-and-resend/regenerate forks
 *  minting their own session (#629 block adoption path) instead of merging
 *  into the parent. */
const ALIGN_PERVASIVE_MIN_FRACTION = 0.2;
const ALIGN_PERVASIVE_MIN_POSITIONS = 2;
/** Minimum byte-identical USER-message positions required for adoption. */
const ALIGN_EXACT_ANCHOR_MIN = 1;
/** Shortest list the alignment will judge — a handful of positions is not
 *  ownership evidence (a shallow match is exactly the #1115 symmetry risk). */
const ALIGN_MIN_DEPTH = 8;
/** Incoming may be deeper than the stored chain (client appended turns since
 *  the last note) but not arbitrarily: a much deeper list is a different
 *  conversation sharing a head, not an append. */
const ALIGN_TAIL_APPEND_MAX = 64;
/** Sketch retention: kept only on the most recently noted anonymous chains
 *  (memory and snapshot bounds — ~64 chains × depth × 17B ≈ 1MB at depth
 *  936) and only for chains seen in the last 24h (older chains keep
 *  exact-hash resolution only, which is what they have always had). */
const SKETCH_MAX_CHAINS = 64;
const SKETCH_MAX_DEPTH = 2048;
const SKETCH_TTL_MS = 24 * 60 * 60 * 1000;

/** #2265 kill-switch: BILI_AFFINITY_SIMHASH=0 disables the simhash adoption
 *  rung (exact-hash resolution and lineage are unaffected — the ladder simply
 *  falls through to a fresh mint, the pre-#2265 behavior). */
let simhashAdoptionEnabled = true;
export function setSimhashAdoptionEnabled(v: boolean): void {
    simhashAdoptionEnabled = v;
}

interface ChainEntry {
    sessionId: string;
    depth: number;
    tailHash: string;
    /** #2601: normalized tail fingerprint — the sorted multiset of the tail
     *  message's string leaves (churn keys dropped) folded through
     *  normalizeMessageText (#2636 discipline) and hashed. Present only when
     *  the tail carries text. Lets chainContinues survive provider/model
     *  switch re-serialization (thinking inlined vs structured, image
     *  placeholder variants) without lowering the byte-exact bar for foreign
     *  histories: different content still hashes differently. */
    normTailHash?: string;
    lastSeen: number;
    /** Per-item hashes (position-independent sha256 of each canonical
     *  message), trailing, capped at MAX_STORED_ITEMS. */
    itemHashes: string[];
    /** #1486: true when the chain belongs to an IDENTIFIED session
     *  (client-provided id). Anonymous resolution must never adopt these —
     *  the anonymous world keeps its own pfa-* ids (#309) even when a client
     *  later replays the same transcript anonymously. */
    identified: boolean;
    /** #2265: per-position simhash sketches (16-hex each, head-anchored,
     *  capped at SKETCH_MAX_DEPTH) for the simhash-adoption rung. Present
     *  only on the SKETCH_MAX_CHAINS most recently noted anonymous chains —
     *  older/identified chains resolve by exact hash only, as before. */
    sketches?: string[];
    /** #2265: per-position user-role flags aligned with itemHashes
     *  (trailing). The ownership-anchor gate counts exact-hash matches only
     *  at user positions — user words are the conversation's fingerprint,
     *  harness machinery is not. Present iff sketches are. */
    userFlags?: boolean[];
}

/** On-disk snapshot entry (#499 P1a): the tracked chains persisted across
 *  restarts so an anonymous replay reattaches its session instead of
 *  forking a fresh one with zero compression state (the #351 failure mode:
 *  a 458K-token history resent raw because the affinity was in-memory). */
export interface AffinitySnapshotEntry {
    sessionId: string;
    depth: number;
    tailHash: string;
    itemHashes: string[];
    lastSeen: number;
    identified?: boolean;
    /** #2265 optional simhash sketches (see ChainEntry.sketches). */
    sketches?: string[];
    /** #2265: user-role flags aligned with itemHashes (present iff sketches). */
    userFlags?: boolean[];
    /** #2601: normalized tail fingerprint (see ChainEntry.normTailHash). */
    normTailHash?: string;
}

/** Deterministic JSON with recursively sorted object keys, so two replays
 *  of the same logical message hash identically regardless of key order. */
export function stableStringify(value: unknown): string {
    return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(record).sort()) out[key] = sortKeys(record[key]);
        return out;
    }
    return value;
}

/** Canonical form for IDENTITY hashing (#2188): sorted-key JSON with every
 *  `cache_control` field dropped. Claude Code stamps a `cache_control`
 *  breakpoint on its last message + last assistant message and MOVES them as
 *  the conversation grows, so a --resume/--fork replay of an earlier history
 *  differs from the parent's final live request ONLY by where those hints sit.
 *  They are transport-layer cache hints, not conversation content — hashing
 *  them made EVERY resume/fork miss findResumeParent (the shared prefix was no
 *  longer byte-stable across a breakpoint shift). Stripping them makes the
 *  identity chain invariant to breakpoint placement while still requiring the
 *  actual content to match byte-for-byte. */
function canonicalForHash(value: unknown): string {
    return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(record).sort()) {
            if (key === "cache_control") continue; // #2188: transport-layer hint, not content
            out[key] = canonicalize(record[key]);
        }
        return out;
    }
    return value;
}

function sha256(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
}

function hasUserMessage(messages: unknown[]): boolean {
    return messages.some((m) => !!m && typeof m === "object" && (m as { role?: unknown }).role === "user");
}

/** Progressive chain hashes: hashes[i] covers messages[0..i]. */
function chainHashes(messages: unknown[]): string[] {
    const hashes: string[] = [];
    let prev = "";
    let bytes = 0;
    for (const message of messages) {
        const canonical = canonicalForHash(message);
        bytes += canonical.length;
        prev = sha256(`${prev}\u0000${canonical}`);
        hashes.push(prev);
    }
    return bytes >= MIN_CANONICAL_BYTES ? hashes : [];
}

/** Position-INDEPENDENT per-item hashes: itemHashes[i] = sha256(canonical(msg_i)).
 *  Unlike the progressive chainHashes (which depend on the full prefix and so
 *  cannot match across a truncation), these support lineage lookups: fork-LCP
 *  from index 0, and truncated-run detection strictly inside a stored chain. */
function perItemHashes(messages: unknown[]): string[] {
    return messages.map((m) => sha256(canonicalForHash(m)));
}

/** #2265: fused per-item fingerprints — one canonical stringify per message
 *  yields BOTH the position-independent item hash (unchanged semantics) and
 *  the simhash sketch (memoized by item hash, so unchanged histories cost
 *  Map lookups on re-resolution). Same total stringify cost as the old
 *  separate pass; the sketch is the extra product. */
function itemFingerprints(messages: unknown[]): { itemHashes: string[]; sketches: string[]; userFlags: boolean[] } {
    const itemHashes: string[] = [];
    const sketches: string[] = [];
    const userFlags: boolean[] = [];
    for (const message of messages) {
        const canonical = canonicalForHash(message);
        const h = sha256(canonical);
        itemHashes.push(h);
        sketches.push(sketchForCanonical(canonical, h));
        userFlags.push(!!message && typeof message === "object" && (message as { role?: unknown }).role === "user");
    }
    return { itemHashes, sketches, userFlags };
}

/** Length of the longest common prefix of two per-item hash arrays. */
function lcpLength(a: string[], b: string[]): number {
    const n = Math.min(a.length, b.length);
    let i = 0;
    while (i < n && a[i] === b[i]) i++;
    return i;
}

/** Strip the leading contiguous run of system/developer-role messages
 *  (#1148). OpenAI-style anonymous clients place their system prompt as
 *  messages[0]; a harness that injects per-turn state into it (date, cwd,
 *  token budget) would otherwise bake those bytes into the identity chain
 *  at depth 0 and mint a fresh session EVERY turn. The other three
 *  protocols carry system text in top-level fields outside the hashed array
 *  (anthropic `system`, responses `instructions`, google `systemInstruction`),
 *  so dropping the leading run aligns OpenAI with them. Only the LEADING
 *  run is dropped — a system/developer item mid-conversation is data. */
function normalizeAffinityMessages(messages: unknown[]): unknown[] {
    let i = 0;
    while (i < messages.length) {
        const m = messages[i];
        if (!m || typeof m !== "object") break;
        const role = (m as { role?: unknown }).role;
        if (role !== "system" && role !== "developer") break;
        i++;
    }
    return i === 0 ? messages : messages.slice(i);
}

/** #2601: leaf keys whose values are provider signatures / transport
 *  identity, not conversation content — they churn when a model/provider
 *  switch re-serializes the history (a different provider re-mints tool-call
 *  ids and thinking signatures). Dropped from the normalized projection. */
const NORM_CHURN_KEYS = new Set(["signature", "id", "cache_control", "tool_use_id", "server_tool_use_id", "web_search_tool_result_id"]);

/** #2601: string leaves shorter than this are structural discriminators
 *  ("text", "tool_use", "user", tool names), not content — they flip when a
 *  provider switch reshapes the same turn (inlined text part vs structured
 *  block), so the projection keeps only content-length leaves plus the
 *  explicit role marker. Short-content-only tails degrade to the byte-exact
 *  check alone (undefined projection) — safe. */
const MIN_NORM_LEAF_LEN = 32;

/** #2601: normalized tail fingerprint at chain depth `depth` — messages[depth-
 *  1]'s string leaves (churn keys dropped, role kept as a marker, content-
 *  length leaves only, sorted so content-block reordering is invisible),
 *  image-capability placeholder lines removed (the #2636 Pass 4 churn),
 *  joined, folded through normalizeMessageText (#2636), hashed. Two
 *  serializations of the same turn project identically (thinking inlined vs
 *  structured, placeholder appended vs stripped); different content does
 *  not. Undefined when that message carries no content leaves — the caller
 *  then keeps the byte-exact check only. Operates on the ALREADY
 *  normalizeAffinityMessages-stripped list (same domain as chainHashes);
 *  `depth` defaults to the list length (the note-time tail). */
function normalizedTailHashOf(messages: unknown[], depth: number = messages.length): string | undefined {
    const tail = depth >= 1 ? messages[depth - 1] : undefined;
    if (!tail || typeof tail !== "object") return undefined;
    const leaves: string[] = [];
    const walk = (v: unknown, key?: string): void => {
        if (typeof v === "string") {
            if (key === "role") { leaves.push(`role\u0000${v}`); return; }
            if (key === undefined || NORM_CHURN_KEYS.has(key)) return;
            if (v.length >= MIN_NORM_LEAF_LEN) leaves.push(v);
            return;
        }
        if (v === null || typeof v !== "object") return;
        if (Array.isArray(v)) {
            for (const item of v) walk(item);
            return;
        }
        for (const k of Object.keys(v as Record<string, unknown>).sort()) walk((v as Record<string, unknown>)[k]!, k);
    };
    walk(tail);
    if (leaves.length === 0) return undefined;
    leaves.sort();
    const lines = leaves.join("\n").split("\n").filter((l) => l !== USER_IMAGE_PLACEHOLDER);
    const text = normalizeMessageText(lines.join("\n"));
    if (!text) return undefined;
    return sha256(`chain-norm\u0000${text}`);
}

/** True iff `needle` occurs contiguously in `haystack` at some offset j ≥ 1
 *  (strictly inside — offset 0 is the full-prefix case, handled by resolve
 *  step 1). Truncated-lineage attribution only (#1115). */
function containsRun(haystack: string[], needle: string[]): boolean {
    const w = needle.length;
    if (w === 0 || haystack.length < w + 1) return false;
    for (let j = 1; j + w <= haystack.length; j++) {
        let hit = true;
        for (let i = 0; i < w; i++) {
            if (haystack[j + i] !== needle[i]) { hit = false; break; }
        }
        if (hit) return true;
    }
    return false;
}

export class PrefixAffinityResolver {
    private trackedChains = new Map<string, ChainEntry>();

    /**
     * Resolve an anonymous request to a session id.
     * Returns null when the request carries no usable conversation signal
     * (caller keeps the #286 explicit 400).
     */
    resolve(input: unknown[]): AnonymousAffinity | null {
        const messages = normalizeAffinityMessages(input);
        const hashes = chainHashes(messages);
        if (hashes.length === 0 || !hasUserMessage(messages)) return null;
        const incomingDepth = hashes.length;
        const tailHash = hashes[incomingDepth - 1]!;
        // #2265: one stringify pass yields both the per-item hashes and the
        //  simhash sketches (memoized by item hash, so an unchanged history
        //  costs one Map lookup per message). Sketches ride every outcome so
        //  note() always has current ones — including the fast path below.
        const fingerprints = itemFingerprints(messages);
        const incItemHashes = fingerprints.itemHashes;
        const incSketches = fingerprints.sketches;
        const incUserFlags = fingerprints.userFlags;
        const storedItemHashes = incItemHashes.slice(-MAX_STORED_ITEMS);
        const tracked = this.trackedChains;

        // 1. Full-depth prefix match (the original radix-style resolution).
        let best: ChainEntry | undefined;
        for (const entry of tracked.values()) {
            if (entry.identified) continue;
            if (entry.depth > incomingDepth) continue;
            if (hashes[entry.depth - 1] !== entry.tailHash) continue;
            if (!best || entry.depth > best.depth || (entry.depth === best.depth && entry.lastSeen > best.lastSeen)) best = entry;
        }
        if (best) {
            return {
                sessionId: best.sessionId,
                matchedDepth: best.depth,
                storedDepth: best.depth,
                incomingDepth,
                tailHash,
                via: "prefix",
                itemHashes: storedItemHashes,
                sketches: incSketches,
                userFlags: incUserFlags.slice(-MAX_STORED_ITEMS),
            };
        }

        // 1.5 #2265 simhash chain alignment — before minting fresh, try to
        //     recognize the incoming list as a NEAR-SIMILAR REWRITE of a
        //     tracked chain: same length (or a short tail append), every
        //     position within a small Hamming distance. That shape is a
        //     client-side decorative mutation (Trae model-tag re-stamp), not
        //     a different conversation — adopting keeps the session and its
        //     fold state, and note() below re-anchors the stored chain on the
        //     mutated bytes so the NEXT request resolves by exact prefix
        //     again (self-healing back to the fast path). Guards: unique
        //     candidate only (two passing chains = ambiguity, refuse to
        //     guess, same ladder discipline as #1692), and any position with
        //     a completely different message fails the candidate — a forked
        //     conversation diverges hard somewhere, which is exactly what
        //     distinguishes adoption from the #1115 symmetric mid-chain match.
        if (simhashAdoptionEnabled) {
            const adopted = this.simhashAdopt(incomingDepth, incSketches, incItemHashes, incUserFlags);
            if (adopted) {
                return {
                    sessionId: adopted.sessionId,
                    matchedDepth: adopted.depth,
                    storedDepth: adopted.depth,
                    incomingDepth,
                    tailHash,
                    via: "simhash",
                    itemHashes: storedItemHashes,
                    sketches: incSketches,
                    userFlags: incUserFlags.slice(-MAX_STORED_ITEMS),
                    adoption: { coverage: adopted.coverage, meanHamming: adopted.meanHamming },
                };
            }
        }

        // 2. New session, anchored deterministically on its current tail so an
        //    identical replay after a proxy restart reattaches the same id.
        //    Lineage (UI/debug ONLY — never used for matching, #1115):
        //    "forked" when the incoming shares a leading prefix with a tracked
        //    chain (diverged/edited history); else "truncated" when its leading
        //    run sits strictly INSIDE a tracked chain (the client dropped its
        //    oldest messages). That second case used to ADOPT the parent
        //    session (tail-window reattach, #316); #1115 removed the adoption
        //    because a mid-chain contiguous match is symmetric evidence, not
        //    ownership — the scan survives solely so logs show where such a
        //    fork was born.
        let lineage: AnonymousAffinity["lineage"];
        let forkParent: ChainEntry | undefined;
        let forkLcp = 0;
        for (const entry of tracked.values()) {
            if (entry.depth > MAX_STORED_ITEMS) continue;
            const lcp = lcpLength(incItemHashes, entry.itemHashes);
            if (lcp >= MIN_FORK_PREFIX && lcp > forkLcp) {
                forkLcp = lcp;
                forkParent = entry;
            }
        }
        if (forkParent) {
            lineage = { parents: [forkParent.sessionId], reason: "forked", sharedPrefix: forkLcp };
        } else {
            const w = Math.min(TRUNCATION_LINEAGE_WINDOW, incomingDepth);
            if (w >= MIN_FORK_PREFIX) {
                const needle = incItemHashes.slice(0, w);
                const parents: string[] = [];
                for (const entry of tracked.values()) {
                    if (containsRun(entry.itemHashes, needle)) parents.push(entry.sessionId);
                }
                if (parents.length > 0) lineage = { parents, reason: "truncated" };
            }
        }
        // #2791 orphan-suspect scan (diagnostics only): a cross-shape replay
        //  breaks EVERY per-item hash, so the ladders above are structurally
        //  blind to "the same conversation, replayed without identity". The
        //  #2601 normalized tail fingerprint (churn keys dropped, content
        //  leaves ≥ MIN_NORM_LEAF_LEN only, folded through
        //  normalizeMessageText) survives re-serialization of the SAME turn:
        //  fingerprint the incoming list AT THE POSITION where the identified
        //  chain ended (entry.depth ≤ incomingDepth — a stateless replay may
        //  have appended turns since). Matching is not adoption evidence —
        //  it is orphan evidence: that conversation's client went anonymous
        //  and its fold ledger is about to be orphaned by this fresh mint.
        //  Append bound uses the simhash rung's yardstick.
        let orphanSuspect: string[] | undefined;
        for (const entry of tracked.values()) {
            if (!entry.identified) continue;
            if (entry.normTailHash === undefined) continue;
            if (incomingDepth < entry.depth || incomingDepth > entry.depth + ALIGN_TAIL_APPEND_MAX) continue;
            if (normalizedTailHashOf(messages, entry.depth) !== entry.normTailHash) continue;
            (orphanSuspect ?? (orphanSuspect = [])).push(entry.sessionId);
        }
        const sessionId = `pfa-${sha256(`${tailHash}\u0000${incomingDepth}`).slice(0, 16)}`;
        return {
            sessionId,
            matchedDepth: 0,
            storedDepth: 0,
            incomingDepth,
            tailHash,
            via: "new",
            itemHashes: storedItemHashes,
            sketches: incSketches,
            userFlags: incUserFlags.slice(-MAX_STORED_ITEMS),
            ...(lineage ? { lineage } : {}),
            ...(orphanSuspect ? { orphanSuspect } : {}),
        };
    }

    /** #2265: the simhash-adoption scan (policy in the constants above —
     *  this method is the mechanics). Returns the single passing candidate
     *  or null; two passing candidates return null (ambiguity refuses to
     *  guess). Candidates: anonymous chains with fresh sketches, seen within
     *  SKETCH_TTL_MS, whose depth the incoming list equals or exceeds by at
     *  most ALIGN_TAIL_APPEND_MAX. Alignment is head-anchored over the
     *  positions both sides have sketches for. */
    private simhashAdopt(incomingDepth: number, incSketches: string[], itemHashes: string[], incUserFlags: boolean[]): { sessionId: string; depth: number; coverage: number; meanHamming: number } | null {
        if (incSketches.length < ALIGN_MIN_DEPTH) return null;
        const now = Date.now();
        let winner: { entry: ChainEntry; coverage: number; meanHamming: number } | null = null;
        let passing = 0;
        for (const entry of this.trackedChains.values()) {
            if (entry.identified) continue;
            if (!entry.sketches || entry.sketches.length < ALIGN_MIN_DEPTH) continue;
            if (now - entry.lastSeen > SKETCH_TTL_MS) continue;
            if (incomingDepth < entry.depth) continue;
            if (incomingDepth - entry.depth > ALIGN_TAIL_APPEND_MAX) continue;
            const alignLen = Math.min(entry.depth, entry.sketches.length, incSketches.length);
            if (alignLen < ALIGN_MIN_DEPTH) continue;
            let similar = 0;
            let mutated = 0;
            let total = 0;
            for (let i = 0; i < alignLen; i++) {
                const d = hammingHex(incSketches[i]!, entry.sketches![i]!);
                if (d < 0 || d > ALIGN_DIVERGENT_HAMMING) { similar = -1; break; }
                total += d;
                if (d <= ALIGN_SIMILAR_HAMMING) {
                    similar++;
                    if (d > 0) mutated++; // similar but NOT byte-identical
                }
            }
            if (similar < 0) continue;
            const coverage = similar / alignLen;
            if (coverage < ALIGN_COVERAGE_MIN) continue;
            if (mutated < Math.max(ALIGN_PERVASIVE_MIN_POSITIONS, alignLen * ALIGN_PERVASIVE_MIN_FRACTION)) continue;
            // Ownership anchor (#2265): a decorative client-side rewrite
            // mutates harness/model-authored items (model tags on assistant
            // messages, reminder wrappers) but leaves the user's own words
            // byte-identical. Two genuinely DIFFERENT conversations — even
            // ones whose boilerplate is 95% shared, so every position passes
            // the Hamming gate and their machinery items hash identically —
            // never share a USER message. The anchor therefore only counts
            // exact matches at user positions: the user's words are the
            // conversation's fingerprint.
            const entryHashes = entry.itemHashes;
            const entryUsers = entry.userFlags;
            if (!entryUsers) continue;
            let exactUser = 0;
            for (let i = 0; i < entryHashes.length && i < entryUsers.length; i++) {
                if (!entryUsers[i]) continue;
                const rawPos = entry.depth - entryHashes.length + i;
                if (rawPos < 0 || rawPos >= itemHashes.length || rawPos >= incUserFlags.length) continue;
                if (incUserFlags[rawPos] && itemHashes[rawPos] === entryHashes[i]) exactUser++;
            }
            if (exactUser < ALIGN_EXACT_ANCHOR_MIN) continue;
            passing++;
            if (passing > 1) return null; // ambiguous — refuse to guess
            winner = { entry, coverage, meanHamming: total / alignLen };
        }
        return winner ? { sessionId: winner.entry.sessionId, depth: winner.entry.depth, coverage: winner.coverage, meanHamming: winner.meanHamming } : null;
    }

    /** Record the chain of a session (on creation and after every anonymous
     *  request — the incoming history is the truth, appends extend it).
     *  `identified` marks client-provided-id chains (#1486); see ChainEntry.
     *  `sketches` (#2265) carries the incoming list's simhash sketches so the
     *  adoption rung has current ones; stored head-anchored, capped at
     *  SKETCH_MAX_DEPTH, and only on the SKETCH_MAX_CHAINS most recently
     *  noted anonymous chains (older chains keep exact-hash resolution). */
    note(sessionId: string, depth: number, tailHash: string, itemHashes: string[], identified = false, sketches?: string[], userFlags?: boolean[], normTailHash?: string): void {
        const tracked = this.trackedChains;
        tracked.delete(sessionId);
        const storedSketches = !identified && sketches && sketches.length > 0 ? sketches.slice(0, SKETCH_MAX_DEPTH) : undefined;
        const storedUsers = storedSketches !== undefined && userFlags && userFlags.length > 0 ? userFlags.slice(-MAX_STORED_ITEMS) : undefined;
        tracked.set(sessionId, { sessionId, depth, tailHash, itemHashes, lastSeen: Date.now(), identified, sketches: storedSketches, userFlags: storedUsers, ...(normTailHash ? { normTailHash } : {}) });
        // #2265 sketch retention: bound how many chains carry sketches. A
        //  fresh note re-anchors the winner, so an eviction from the sketch
        //  window only degrades that chain to exact-hash resolution.
        if (storedSketches !== undefined) {
            const withSketches = [...tracked.values()].filter((e) => e.sketches !== undefined);
            if (withSketches.length > SKETCH_MAX_CHAINS) {
                const drop = new Set(
                    withSketches
                        .sort((a, b) => a.lastSeen - b.lastSeen)
                        .slice(0, withSketches.length - SKETCH_MAX_CHAINS)
                        .map((e) => e.sessionId),
                );
                for (const id of drop) {
                    const e = tracked.get(id);
                    if (e) { delete e.sketches; delete e.userFlags; }
                }
            }
        }
        while (tracked.size > MAX_TRACKED_SESSIONS) {
            const oldest = [...tracked.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
            if (!oldest) break;
            tracked.delete(oldest.sessionId);
        }
    }

    /** #1486: current tracking entry for a session id, without
     *  touching lastSeen. Lets the identified-session tracker apply the
     *  append-only discipline (#1075 side requests reuse a session id with
     *  fewer messages) before overwriting. */
    peekChain(sessionId: string): ChainEntry | undefined {
        return this.trackedChains.get(sessionId);
    }

    /** #1486: fingerprint an incoming message list without resolving it —
     *  the building block for tracking identified sessions and for
     *  resume-fork detection. Null when the request is degenerate (below
     *  MIN_CANONICAL_BYTES, no user message). */
    chainFingerprint(messages: unknown[]): { depth: number; tailHash: string; itemHashes: string[]; normTailHash?: string } | null {
        const msgs = normalizeAffinityMessages(messages);
        if (!hasUserMessage(msgs)) return null;
        const hashes = chainHashes(msgs);
        if (hashes.length === 0) return null;
        return {
            depth: msgs.length,
            tailHash: hashes[hashes.length - 1]!,
            itemHashes: perItemHashes(msgs).slice(-MAX_STORED_ITEMS),
            normTailHash: normalizedTailHashOf(msgs),
        };
    }

    /** #1486: resume-fork detection for identified clients. Clients such as
     *  Claude Code fork a fresh client-provided session id on --resume while
     *  replaying the FULL transcript. Returns the tracked session whose ENTIRE
     *  stored chain is a byte-exact head-anchored prefix of the incoming
     *  history: the progressive hash at index depth-1 must equal the stored
     *  tailHash. That check stays valid beyond MAX_STORED_ITEMS because the
     *  progressive hash covers the whole prefix (unlike the capped per-item
     *  window used for lineage lookups). The candidate must be STRICTLY
     *  deeper than the parent: a real resume adds at least one new message,
     *  while an equal-depth byte-exact replay under a DIFFERENT id is a
     *  duplicate conversation, not a resume — linking it would adopt foreign
     *  blocks and trip the derived-parent restrictions (#1486). The parent
     *  chain must be >= MIN_RESUME_PREFIX deep. Deepest match wins; ties go
     *  to the most recently seen. */
    findResumeParent(messages: unknown[], selfSessionId: string): { sessionId: string; sharedDepth: number } | null {
        const msgs = normalizeAffinityMessages(messages);
        if (!hasUserMessage(msgs)) return null;
        const hashes = chainHashes(msgs);
        if (hashes.length < MIN_RESUME_PREFIX) return null;
        let best: { sessionId: string; sharedDepth: number; lastSeen: number } | null = null;
        for (const [id, entry] of this.trackedChains) {
            if (id === selfSessionId) continue;
            if (entry.depth < MIN_RESUME_PREFIX) continue;
            if (msgs.length <= entry.depth) continue;
            if (hashes[entry.depth - 1] !== entry.tailHash) continue;
            if (!best || entry.depth > best.sharedDepth || (entry.depth === best.sharedDepth && entry.lastSeen > best.lastSeen)) {
                best = { sessionId: id, sharedDepth: entry.depth, lastSeen: entry.lastSeen };
            }
        }
        return best ? { sessionId: best.sessionId, sharedDepth: best.sharedDepth } : null;
    }

    /** #2408: the DECLARED-parent variant of findResumeParent — an explicit
     * lineage declaration (claude --fork-session SessionStart register,
     * opencode derived register) scopes the content match to that parent's
     * chain only, killing the multi-chain ambiguity the unscoped scan
     * refuses to guess on. Same head-anchored byte-exact judgement as
     * findResumeParent (strictly deeper than the parent, >=
     * MIN_RESUME_PREFIX). Null when the parent chain is untracked or its
     * replay does not match — the caller then falls back to the read-only
     * derived link (#1333). */
    findResumeParentWithin(parentId: string, messages: unknown[], selfSessionId: string): { sessionId: string; sharedDepth: number } | null {
        if (parentId === selfSessionId) return null;
        const entry = this.trackedChains.get(parentId);
        if (entry === undefined || entry.depth < MIN_RESUME_PREFIX) return null;
        const msgs = normalizeAffinityMessages(messages);
        if (!hasUserMessage(msgs)) return null;
        const hashes = chainHashes(msgs);
        if (hashes.length < MIN_RESUME_PREFIX) return null;
        if (msgs.length <= entry.depth) return null;
        if (hashes[entry.depth - 1] !== entry.tailHash) return null;
        return { sessionId: parentId, sharedDepth: entry.depth };
    }

    /** #2241: does `messages` continue the tracked chain of `sessionId`?
     * True when the session's stored chain is a byte-exact head-anchored
     * prefix of the incoming list — the progressive hash at the stored
     * depth equals the stored tail hash (equal depth = byte-exact replay,
     * which also counts). The building block for the dsh persona anchor
     * migration: a system-text change whose history continues the raw
     * key's chain is the SAME conversation (model switch), not a new
     * persona. Cryptographic equality of the whole prefix is the
     * discriminator — no depth floor beyond chainHashes' MIN_CANONICAL_BYTES. */
    chainContinues(messages: unknown[], sessionId: string): boolean {
        const entry = this.trackedChains.get(sessionId);
        if (!entry) return false;
        const msgs = normalizeAffinityMessages(messages);
        if (!hasUserMessage(msgs)) return false;
        const hashes = chainHashes(msgs);
        if (hashes.length === 0 || msgs.length < entry.depth) return false;
        if (hashes[entry.depth - 1] === entry.tailHash) return true;
        // #2601 second chance: a model/provider switch re-serializes the
        // recorded region (thinking inlined vs structured, image placeholder
        // variants, provider re-minted ids/signatures) — same conversation,
        // different protocol bytes, so the byte-exact progressive hash misses
        // while the stored chain is genuinely the prefix. The normalized tail
        // projection (text leaves, churn keys dropped, formatting folded —
        // the #2636 fold-reconcile discipline) still matches, so the dsh
        // persona anchor MIGRATES instead of forking the session onto
        // `|sub:<fp>` where host-stamped management calls cannot follow.
        // Foreign histories (different content) still hash differently.
        return entry.normTailHash !== undefined && normalizedTailHashOf(msgs, entry.depth) === entry.normTailHash;
    }

    /** Drop tracking for a removed session. */
    forget(sessionId: string): void {
        this.trackedChains.delete(sessionId);
    }

    trackedSessionIds(): string[] {
        return [...this.trackedChains.keys()];
    }

    /** Serializable copy of the tracked chains (for #499 P1a persistence). */
    exportSnapshot(): AffinitySnapshotEntry[] {
        return [...this.trackedChains.values()].map((e) => ({
            sessionId: e.sessionId,
            depth: e.depth,
            tailHash: e.tailHash,
            itemHashes: e.itemHashes,
            lastSeen: e.lastSeen,
            identified: e.identified,
            ...(e.normTailHash ? { normTailHash: e.normTailHash } : {}),
            ...(e.sketches ? { sketches: e.sketches, ...(e.userFlags ? { userFlags: e.userFlags } : {}) } : {}),
        }));
    }

    /** Load chains persisted by a previous process. Chains are permanent
     *  (#1724): an entry months old still reattaches its session. Returns
     *  the count actually imported. Defensive: a corrupt/hand-edited file
     *  must never crash the proxy — malformed entries are skipped. */
    importSnapshot(entries: unknown): number {
        if (!Array.isArray(entries)) return 0;
        let imported = 0;
        for (const raw of entries) {
            if (!raw || typeof raw !== "object") continue;
            const e = raw as Record<string, unknown>;
            if (typeof e.sessionId !== "string" || typeof e.depth !== "number" || typeof e.tailHash !== "string") continue;
            if (!Array.isArray(e.itemHashes) || e.itemHashes.some((h) => typeof h !== "string")) continue;
            if (typeof e.lastSeen !== "number") continue;
            // #2265: optional per-position simhash sketches — defensive, a
            //  malformed list degrades the entry to exact-hash resolution.
            let sketches: string[] | undefined;
            if (Array.isArray(e.sketches)) {
                const valid = (e.sketches as unknown[]).filter(
                    (s): s is string => typeof s === "string" && /^[0-9a-f]{16}$/.test(s),
                );
                if (valid.length >= ALIGN_MIN_DEPTH) sketches = valid.slice(0, SKETCH_MAX_DEPTH);
            }
            // #2265: user-role flags for the ownership-anchor gate — optional,
            //  malformed lists simply degrade the entry (no user anchor → the
            //  simhash rung skips it, exact-hash resolution still works).
            let userFlags: boolean[] | undefined;
            if (sketches !== undefined && Array.isArray(e.userFlags)) {
                const validU = (e.userFlags as unknown[]).filter((u): u is boolean => typeof u === "boolean");
                if (validU.length > 0) userFlags = validU.slice(-MAX_STORED_ITEMS);
            }
            const entry: ChainEntry = {
                sessionId: e.sessionId,
                depth: e.depth,
                tailHash: e.tailHash,
                itemHashes: (e.itemHashes as string[]).slice(-MAX_STORED_ITEMS),
                lastSeen: e.lastSeen,
                identified: e.identified === true,
                sketches,
                ...(typeof e.normTailHash === "string" && /^[0-9a-f]{64}$/.test(e.normTailHash) ? { normTailHash: e.normTailHash } : {}),
                ...(userFlags ? { userFlags } : {}),
            };
            this.trackedChains.delete(entry.sessionId);
            this.trackedChains.set(entry.sessionId, entry);
            imported++;
        }
        while (this.trackedChains.size > MAX_TRACKED_SESSIONS) {
            const oldest = [...this.trackedChains.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
            if (!oldest) break;
            this.trackedChains.delete(oldest.sessionId);
        }
        return imported;
    }
}

/** Shared resolver instance (per proxy process). */
export const prefixAffinity = new PrefixAffinityResolver();
