// #1875: machine-readable business outcome for executed proxy tools. The HTTP
// envelope's ok already means "transport + execution succeeded"; outcome adds
// whether the REQUESTED EFFECT happened. Compress is tri-valued (applied /
// partial / refused) because a partially-applied fold is neither; every other
// tool is binary success | failure. Consumers that only know the old envelope
// shape ignore the extra fields and keep working off result text.
type CompressOutcomeKind = "applied" | "partial" | "refused";
type ToolOutcomeKind = CompressOutcomeKind | "success" | "failure";

export interface ProxyToolResult {
    text: string;
    outcome?: ToolOutcomeKind;
    blocksCreated?: number;
    // #2362: short machine-readable failure cause for log correlation (e.g.
    // `parse:missing-content`, `gate:cannot-anchor`) — outcome=refused alone
    // never says WHY in the [plugin] execution line.
    reason?: string;
    // #2780: exact original for a large exported CCR retrieve, returned inline so
    // the caller never depends on reading <stateDir>/retrieve/<ref>.txt — remote
    // callers can't read that local path, and identical refs across sessions collide
    // on it. Additive: `text` (the framed pointer) is unchanged.
    retrievalExport?: { path: string; text: string };
}

export function toolOk(text: string): ProxyToolResult {
    return { text, outcome: "success" };
}

export function toolFail(text: string): ProxyToolResult {
    return { text, outcome: "failure" };
}

export function compressResult(text: string, outcome: CompressOutcomeKind, blocksCreated: number, reason?: string): ProxyToolResult {
    return reason !== undefined ? { text, outcome, blocksCreated, reason } : { text, outcome, blocksCreated };
}
