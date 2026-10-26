# Ref-Keyed Surfaces Registry (#4797 phase C audit)

> **Purpose**: the ledger-alignment restamp (`restampRefsToLedger`, #4316 PR3/3) renumbers message refs. It is a MULTI-SURFACE migration: every state field / store / view keyed by ref number must move with it. Three leaks shipped before this registry existed (#4757 tokenSnapshot, #4733 CCR store, #4797 superseded/live collision). **Any new code that keys anything by an `mNNNNN` ref must register here and be added to the restamp pass (or proven ref-free).**

## The restamp pass — what migrates today

| Surface | Keyed by | Migrated where | Notes |
|---|---|---|---|
| `state.messageRefs` (`byRaw`/`byRef`) | ref ↔ rawId | `kernel/src/refs.ts restampRefsToLedger` | authoritative live space; sets `refLedgerAligned` |
| `state.tokenSnapshot` | ref | `src/persist.ts maybeRestampToLedger` (#4757, 4c6aefea) | two-pass move, no swap loss |
| CCR content store aliases | ref | `restampContentStore` (#4733), same pass | live claims first; dead keys frozen |
| `session.restampSuperseded` | oldRef→rawId | produced by the pass | **process-lifetime only, never persisted, must be cleared on empty outcome** |

## Ref-keyed and NOT (yet) migrated — the collision band

| Surface | Keyed by | Status | Consequence if unmigrated |
|---|---|---|---|
| `blocks[].startRef/endRef` | ref strings | **stale after restamp** (display) | nudge block map + decompress receipts print old numbers (`resolveBlockSpan` prefers them) — fix: prefer `startSeq/endSeq`-derived live refs |
| `state.deadRefs` | ref numbers | **stale** | number-keyed `excludeDeadRefRanges` over-filters the NEW owner of a dead number (safe direction, wrong behavior) — fix: remap in the restamp pass |
| `state.hiddenOrphanRefs` | refs | stale | hidden orphan pairs resurrect mid-history (#3769 regression class) |
| `state.emergencyTruncateLatch[].ref`, `renderDeferredRefs`, `viewLatches`, `pendingOrphanSweepMinRef` | refs/number | stale | latch misses → replay divergence → prefix-cache churn (one-time rewrite) |
| `messages.ref_num` (unified store rows) | ref number | **index-time, never rewritten** | web leaf hydration + export JSONL query NEW numbers against OLD rows → silent misses for the renumbered band (#4738 family) |

## Flag propagation contract (kernel)

`state.refLedgerAligned` is the one-time gate. It is written ONLY by `restampRefsToLedger` (kernel/src/refs.ts) and MUST survive:
- `syncBlocks` state clone (kernel/src/sync.ts) — processTurn path
- `cloneState` (kernel/src/compress.ts, applyCompression path)

Losing it re-arms the restamp every turn; the re-stamp is a numbering no-op after convergence but keeps the superseded map alive forever (host only overwrites `session.restampSuperseded` when non-empty).

## The superseded/live collision (#4797 root)

`restampRefsToLedger` vacates an old number and records it in `superseded` — but the SAME pass hands vacated numbers to other messages as `seq+1` targets. Post-pass, a number can be **simultaneously live (byRaw/byRef) and a superseded key**. Any consumer that consults `superseded` before the live map misclassifies live refs.

**Contract (enforced by kernel post-pass prune + host guard priority):**
1. Kernel: after the pass, drop `superseded` entries whose key resolves in the final live map.
2. Host guard (`supersededRefRejection`, src/stream.ts): a ref that resolves LIVE is never superseded — liveness first; only genuinely-dead numbers consult the map; translation `oldRef→rawId→live ref` is identity-preserving and mandatory for model-cited pre-restamp refs (the model may cite any number it has ever seen — kernel contract).

## Inbound/outbound ref surfaces (verified all-live 2026-10-26, phase C audit)

Outbound emitters all derive from live `state.messageRefs` via the kernel render pipeline (render-refs.ts) or `byRaw` lookups — see audit tables in PR #4805. Inbound acceptors: compress (`supersededRefRejection`), decompress range/imageRef (fail-soft), CCR retrieve (store rekeyed). The one bypass: `loadStateForSearch` (src/persist.ts) reads the shadow view WITHOUT `afterLoad` — pre-restamp copy for foreign-session search_context.

## Restamp trigger surfaces

- Unified cold load: `loadUnified` hit / strictly-ahead envelope recovery / fresh import (src/persist.ts afterLoad).
- **LRU eviction mid-conversation**: `getSession` memory-miss → `loadSync` → afterLoad — the "restart boundary has no in-flight compress call" rationale does NOT hold here; pre-eviction outbound tags are still in the wild. The identity-preserving translation above is what makes this safe.
