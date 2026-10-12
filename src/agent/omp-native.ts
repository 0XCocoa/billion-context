// Native omp mode (#957): the package-installed omp extension bootstraps its
// own proxy — bare `omp` (with this package installed via
// `bili plugin install omp`) gets full plugin-mode compression with NO
// launcher. Same flow as pi-native.ts (#519):
//   1. spawn the package's own proxy (`dist/index.js start`, ephemeral
//      port, parent-pid watchdog = this omp process) via ensureProxyRunning —
//      a healthy compatible instance is ATTACHED, not doubled;
//   2. patch globalThis.fetch (native-intercept.ts) so model-API requests
//      are rewritten to `<proxy>/bili/<full-upstream-url>` (verified
//      patchable under Bun — omp runs on a bundled bun);
//   3. set BILLION_CONTEXT_PROXY so the shared plugin (pi.ts) detects the
//      proxy through its existing env fallback — tools, /acp, the compaction
//      cancel and the prompt_cache_key stamp all reuse the launcher-mode
//      code paths. omp never emits before_provider_headers, so its
//      runtime-info report (#955) rides before_provider_request instead.
// Posture (planNativeOmp — #886/#983 mechanism, ported to the omp lane for
// #1795): a preset BILLION_CONTEXT_PROXY (or explicit BILLION_CONTEXT_ATTACH)
// is an ATTACH target, not a stand-down — the pseudo-attach hole used to
// disarm routing entirely while tools still found the proxy through the env,
// sending every model request direct and uncompressed. Stand down only for a
// /bili/ rewrite launch (BILI_PROVIDER_REWRITES) or an opt-out
// (BILLION_CONTEXT_PLUGIN=0 / BILI_NATIVE_OMP=0).

import { ensureProxyRunning, LAUNCHER_DEFAULT_HOST } from "../launcher.js";
import { createBiliPlugin } from "./pi.js";
import { applyOmpFirstEventTimeout, markNativeHost, nativeAttachOrigin, nativeBootstrapGate, nativeProxyScriptPath, proxyEnvOrigin, setNativeOriginWaiter, singleFlight } from "./native-bootstrap.js";
import { installNativeFetchIntercept, noteRoutedOrigin, observeRoutedOrigin, readyOrigin, type NativeInterceptState } from "./native-intercept.js";
import { fetchProxyVersion, waitForProxyVersion } from "./shared.js";
import { logHostEvent } from "./host-log.js";

/** Decides whether the native bootstrap should run in this process. */
export function shouldBootstrapNativeOmp(env: NodeJS.ProcessEnv): boolean {
    return nativeBootstrapGate(env, "BILI_NATIVE_OMP");
}

/** Decide this process's native posture (#886/#983 mechanism, ported to the
 *  omp lane in #1795). Precedence kill-switch > /bili/ rewrite launch >
 *  attach > spawn. A preset BILLION_CONTEXT_PROXY is an ATTACH target, not a
 *  stand-down: the pseudo-attach hole (preset env + bare omp) used to disarm
 *  routing entirely while tools still found the proxy through the env — model
 *  traffic went direct and uncompressed, the proxy never saw the session, and
 *  every tool forward 404'd. Attach keeps the user's intent ("route through
 *  THIS proxy"); explicit BILLION_CONTEXT_ATTACH wins when both are set. A
 *  /bili/ launch (BILI_PROVIDER_REWRITES) still stands us down — its URLs are
 *  already proxy-shaped. */
export function planNativeOmp(env: NodeJS.ProcessEnv): { mode: "off" | "attach" | "spawn"; attachOrigin?: string } {
    if (env.BILLION_CONTEXT_PLUGIN === "0" || env.BILI_NATIVE_OMP === "0") return { mode: "off" };
    if (env.BILI_PROVIDER_REWRITES !== undefined) return { mode: "off" };
    const attachOrigin = nativeAttachOrigin(env) ?? proxyEnvOrigin(env);
    if (attachOrigin !== undefined) return { mode: "attach", attachOrigin };
    return { mode: "spawn" };
}

/** #1774: true when this OMP process routes model traffic through a bili proxy —
 *  self-bootstrap (gate passed), launcher/MITM launch (BILLION_CONTEXT_PROXY), or
 *  /bili/-rewrite launch (BILI_PROVIDER_REWRITES). Only then can a long preflight
 *  outrun OMP's 300s first-parsed-event watchdog. */
export function ompTrafficRidesBili(env: NodeJS.ProcessEnv): boolean {
    return nativeBootstrapGate(env, "BILI_NATIVE_OMP")
        || proxyEnvOrigin(env) !== undefined
        || env.BILI_PROVIDER_REWRITES !== undefined;
}

function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

const state: NativeInterceptState = { origin: undefined, ready: Promise.resolve(undefined) };

async function bootstrap(): Promise<string | undefined> {
    try {
        const handle = await ensureProxyRunning(
            { host: LAUNCHER_DEFAULT_HOST, port: 0, passthrough: false, debug: false, lane: "omp" },
            { scriptPath: nativeProxyScriptPath() },
        );
        const origin = handle.origin;
        state.origin = origin;
        process.env.BILLION_CONTEXT_PROXY = origin;
        return origin;
    } catch (err) {
        logHostEvent("error", "[native-client]", `bili-native: proxy bootstrap failed — model traffic goes direct (uncompressed): ${errMessage(err)}`);
        return undefined;
    }
}

let _spawnForTest: (() => Promise<string | undefined>) | undefined;

/** Test hook: replace the attach-fallback spawn (and the respawn self-heal's
 *  spawn) with a stub. Pass undefined to restore. */
export function _setSpawnForTest(fn?: () => Promise<string | undefined>): void {
    _spawnForTest = fn;
}

/** #1135/#1365: the attached origin can go stale — at startup (the owning
 *  launcher exited before this process started) or at runtime (it exits while
 *  this session still rides the shared proxy, #1130). Probe before trusting
 *  it: healthy → keep attaching (a transient blip costs nothing — the session
 *  never migrates). DEAD + routed-channel evidence (#1365: /bili/-baked model
 *  traffic was observed at some origin) → the session's context lives at THAT
 *  origin, so wait for the pinned target to come back (bounded by
 *  BILI_ATTACH_HEALTH_DEADLINE_MS) instead of spawning — a second instance
 *  would serve tools while the model channel stays pinned elsewhere and every
 *  bili tool call 404s against it (unrecoverable split); the env is preserved
 *  so the user's target stays declared. DEAD with no evidence after the grace
 *  window (BILI_ATTACH_EVIDENCE_GRACE_MS) → unfreeze the preset env and fall
 *  back to spawning our own proxy, re-arming respawn as a pure spawn. Resolves
 *  to the origin the client should use — the (recovered) attach origin, the
 *  fallback origin, or undefined when nothing came up. */
export async function verifyAttachAndRecover(attachOrigin: string): Promise<string | undefined> {
    // #1365: routed evidence outranks the planned origin — probe where the
    // model channel actually points, not where the env says it should.
    const home = state.routedOrigin ?? attachOrigin;
    const version = await fetchProxyVersion(home).catch(() => undefined);
    if (version !== undefined) {
        // Restore the readyOrigin short-circuit — a runtime recovery clears
        // state.origin before re-probing, and a transient blip must not leave
        // it dangling.
        state.origin = home;
        process.env.BILLION_CONTEXT_PROXY = home;
        return home;
    }
    const pinned = state.routedOrigin ?? (await observeRoutedOrigin(state));
    if (pinned !== undefined) {
        const back = await waitForProxyVersion(pinned);
        if (back !== undefined) {
            state.origin = back;
            process.env.BILLION_CONTEXT_PROXY = back;
            logHostEvent("info", "[native-client]", `bili-native(omp): attach target ${pinned} is healthy again — attached, no second instance spawned`);
            return back;
        }
        logHostEvent("error", "[native-client]", `bili-native(omp): attach target ${pinned} is down and this process's model channel is pinned to it — refusing to spawn a second instance (bili tools would 404 against the other one). Start your proxy at ${pinned} or unset BILLION_CONTEXT_PROXY; bili keeps re-checking and self-heals when it comes back.`);
        state.origin = undefined;
        return undefined;
    }
    logHostEvent("error", "[native-client]", `bili-native(omp): attach target ${attachOrigin} is not healthy — falling back to a spawned proxy`);
    delete process.env.BILLION_CONTEXT_PROXY;
    state.attach = false;
    state.origin = undefined;
    const start = singleFlight(_spawnForTest ?? bootstrap);
    state.respawn = start;
    // Publish whatever origin lands on BOTH the shared state and the env —
    // env readers (compaction reporter, /acp status) must never disagree with
    // what the route resolves, whoever produced the origin.
    const landed = start().then((o) => {
        if (o !== undefined) {
            state.origin = o;
            process.env.BILLION_CONTEXT_PROXY = o;
        }
        return o;
    });
    state.ready = landed;
    return landed;
}

const plan = planNativeOmp(process.env);

/** Wire the shared intercept state for the planned mode. Attach mode arms
 *  even under NODE_TEST_CONTEXT (it installs no global patches and spawns
 *  nothing while the target is healthy, so tests can drive it directly);
 *  spawn mode stays test-guarded because bootstrap forks a real proxy. */
export function armNativeOmp(p: typeof plan): void {
    if (p.mode === "off") return;
    markNativeHost(process.env, "omp");
    if (p.mode === "attach") {
        state.attach = true;
        const attachOrigin = p.attachOrigin;
        if (attachOrigin !== undefined) {
            // #1135: arm the SAME probe+fallback for runtime death — the
            // attached proxy is usually owned by ANOTHER launcher that can
            // exit while this session rides it; the resolver then re-probes
            // and falls back exactly like at startup. No synchronous
            // state.origin freeze: the fetch intercept resolves live per
            // request via readyOrigin(state).
            process.env.BILLION_CONTEXT_PROXY = attachOrigin;
            const start = singleFlight(() => verifyAttachAndRecover(attachOrigin));
            state.respawn = start;
            state.onGiveUp = () => {
                delete process.env.BILLION_CONTEXT_PROXY;
            };
            // #1365: late routed evidence — if model traffic later arrives baked
            // against a DIFFERENT origin than the one we attached to, rebind there
            // (the context lives where the models go). Fire-and-forget with a
            // liveness check: only converge on a target we can actually reach.
            state.onRoutedOriginObserved = (origin) => {
                if (state.origin === origin) return;
                void fetchProxyVersion(origin).catch(() => undefined).then((version) => {
                    if (version === undefined || state.origin === origin) return;
                    state.origin = origin;
                    process.env.BILLION_CONTEXT_PROXY = origin;
                    logHostEvent("warn", "[native-client]", `bili-native(omp): model channel pinned to ${origin} — rebinding bili tools there`);
                });
            };
            state.ready = start();
        } else {
            state.ready = Promise.resolve(undefined);
        }
    } else if (process.env.NODE_TEST_CONTEXT === undefined) {
        const start = singleFlight(bootstrap);
        state.respawn = start;
        // #1531: pi-native's #1243 pattern — before_provider_request reads the
        // proxy base from BILLION_CONTEXT_PROXY, which bootstrap() writes
        // asynchronously. Publish the ready promise so the awaited runtime-info
        // report can wait on the writer instead of racing it.
        setNativeOriginWaiter({ wait: () => readyOrigin(state) });
        state.onGiveUp = () => {
            // We wrote BILLION_CONTEXT_PROXY at successful bootstrap. If the proxy
            // dies mid-session and the respawn fails, traffic goes direct — clear
            // the env so event-time ownership checks (session_before_compact
            // cancel, prompt_cache_key stamping) stop claiming compression
            // ownership and native compaction comes back with the direct traffic.
            delete process.env.BILLION_CONTEXT_PROXY;
        };
        state.ready = start();
    }
}

if (plan.mode !== "off") armNativeOmp(plan);

// #1774: widen OMP's first-parsed-event watchdog before any stream can start — a
// preflight over a large context holds the response for minutes while OMP only
// sees keep-alive comments, and its default 300s timer would abort mid-compression.
// Sync at module eval so it lands before the first request; user-pinned values win.
if (process.env.NODE_TEST_CONTEXT === undefined && ompTrafficRidesBili(process.env)) {
    applyOmpFirstEventTimeout(process.env);
}

// node:test imports this module for shouldBootstrapNativeOmp — never
// patch globalThis.fetch or bootstrap a real proxy from inside a test run.
if (process.env.NODE_TEST_CONTEXT === undefined && plan.mode !== "off") {
    installNativeFetchIntercept(state);
}

/** Test hook: expose the armed runtime-recovery seam (mirrors pi/opencode/dsh). */
export function _stateRespawnForTest(): (() => Promise<string | undefined>) | undefined {
    return state.respawn;
}

/** Test hook (#1365): record routed-channel evidence without the fetch patch. */
export function _noteRoutedForTest(url: string): void {
    noteRoutedOrigin(state, url);
}

/** Test hook: reset the module-level state in place (closures capture the
 *  object reference) so suites can drive armNativeOmp repeatedly. */
export function _resetNativeStateForTest(): void {
    state.attach = undefined;
    state.origin = undefined;
    state.routedOrigin = undefined;
    state.onRoutedOriginObserved = undefined;
    state.respawn = undefined;
    state.onGiveUp = undefined;
    state.ready = Promise.resolve(undefined);
    _spawnForTest = undefined;
    delete process.env.BILLION_CONTEXT_PROXY;
}

export default createBiliPlugin("omp");
