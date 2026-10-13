/**
 * EADDRINUSE retry policy for the proxy's own listen socket (#407/#964/#1723/#3044).
 * Pure decision table extracted from the server's 'error' handler so every
 * branch can be pinned without booting a server.
 *
 * #3044: a self-restart replacement must own EXACTLY the port its predecessor
 * freed. Hopping +1 strands it serving no client while the prior instance
 * keeps holding the real port — the orphan-leak shape reported in #3044. It
 * gets the bounded same-port predecessor wait (#1723 overlap: slow release),
 * then fails fast instead of laddering.
 */
/** Internal spawn-channel env set by performSelfRestart onto its replacement
 *  (#3044): the marked process must bind-or-die on exactly the freed port. */
export const UPGRADE_REPLACEMENT_ENV = "BILI_UPGRADE_REPLACEMENT";

export type EaddrinuseAction =
    | { kind: "wait-predecessor"; port: number }
    /** nextPort 0 = ask the OS for an ephemeral port (ladder exhausted). */
    | { kind: "ladder"; nextPort: number }
    | { kind: "fail-fast"; reason: "upgrade-replacement" | "strict-port" | "port-busy" };

export interface EaddrinuseContext {
    /** #3044: this process is a self-restart replacement (BILI_UPGRADE_REPLACEMENT). */
    upgradeReplacement: boolean;
    launchToken: boolean;
    strictPort: boolean;
    attempts: number;
    maxAttempts: number;
    predecessorTicksLeft: number;
    predecessorHolds: boolean;
    lastTriedPort: number;
}

export function decideEaddrinuse(ctx: EaddrinuseContext): EaddrinuseAction {
    if (ctx.upgradeReplacement) {
        if (ctx.predecessorTicksLeft > 0 && ctx.predecessorHolds) {
            return { kind: "wait-predecessor", port: ctx.lastTriedPort };
        }
        return { kind: "fail-fast", reason: "upgrade-replacement" };
    }
    if (!ctx.launchToken || ctx.strictPort || ctx.attempts >= ctx.maxAttempts) {
        return { kind: "fail-fast", reason: ctx.strictPort ? "strict-port" : "port-busy" };
    }
    if (ctx.predecessorTicksLeft > 0 && ctx.predecessorHolds) {
        return { kind: "wait-predecessor", port: ctx.lastTriedPort };
    }
    const nextAttempts = ctx.attempts + 1;
    return { kind: "ladder", nextPort: nextAttempts === ctx.maxAttempts ? 0 : ctx.lastTriedPort + 1 };
}
