#!/usr/bin/env node
// #2816: CI test scheduling. The node built-in runner defaults file
// concurrency to availableParallelism()-1 == 1 on 2-vCPU runners, so all
// 600+ top-level suites ran strictly serially, each paying a full
// node+tsx spawn. That schedule is still REQUIRED for the live/process
// suites — #1248 documents claude-native live e2e flaking (kill ESRCH,
// port timeouts, multi-minute hangs) under concurrent load — but the
// other ~570 suites never spawn a process, use listen(0) ports and
// per-file XDG-isolated homes, so they can safely share the machine:
//
//   phase 1 "live": process-spawning suites, concurrency=1 — byte-for-byte
//                   the conditions the suite has always run under in CI
//                   (serial + quiet machine);
//   phase 2 "pool": everything else, concurrency=4.
//
// Same tests, same assertions, same env vars — only the schedule changes.
// Local `npm test` is untouched (this script is CI-only).
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const testsDir = join(root, "tests");

// Process-spawning suites (grep ground truth: spawn/exec*/child_process/Worker
// references below). Conservative by design — a false positive just costs a
// slot in the serial phase; a false negative would put a live suite into the
// concurrent pool and re-open #1248. New spawning suites MUST be added here.
const LIVE_FILES = [
    "tests/auto-restart.test.ts",
    "tests/build-info.test.ts",
    "tests/cache-theorem.test.ts",
    "tests/claude-native.test.ts",
    "tests/e2e-plugin-tool-routing.test.ts",
    "tests/graceful-close.test.ts",
    "tests/hermes-native.test.ts",
    "tests/hook-command.test.ts",
    "tests/index-entry-guard.test.ts",
    "tests/issue1958-routed-warn.test.ts",
    "tests/issue760-percall-conversation.test.ts",
    "tests/issue927-opencode-install.test.ts",
    "tests/kimi-native.test.ts",
    "tests/launcher-plugin-mode.test.ts",
    "tests/launcher-sqlite-overlay.test.ts",
    "tests/launcher.test.ts",
    "tests/logger-epipe.test.ts",
    "tests/mcp-native-thread.test.ts",
    "tests/multi-instance-live.test.ts",
    "tests/omp-native.test.ts",
    "tests/opencode-native.test.ts",
    "tests/overlay-busy-lock.test.ts",
    "tests/pi-native.test.ts",
    "tests/plugin-fork.test.ts",
    "tests/port-zone-live.test.ts",
    "tests/port-zone.test.ts",
    "tests/release-ci-gate.test.ts",
    "tests/watchdog-health-daemon.test.ts",
    "tests/watchdog-health.test.ts",
    "tests/win-cmd-argv.test.ts",
    "tests/zcode-mcp-degraded.test.ts",
    "tests/zcode-real-cli.test.ts",
];

const SPAWN_RE = /\bspawn[A-Za-z]*\s*\(|child_process|execFile|execSync|spawnSync|new Worker\(/;

const allFiles = readdirSync(testsDir)
    .filter((f) => f.endsWith(".test.ts"))
    .sort()
    .map((f) => `tests/${f}`);

function die(msg) {
    console.error(`::error::${msg}`);
    console.error(`[ci-tests] ${msg}`);
    process.exit(1);
}

for (const f of LIVE_FILES) {
    if (!allFiles.includes(f)) die(`LIVE_FILES entry ${f} does not exist`);
}
const unregistered = allFiles.filter(
    (f) => !LIVE_FILES.includes(f) && SPAWN_RE.test(readFileSync(join(root, f), "utf8")),
);
if (unregistered.length > 0) {
    die(
        `process-spawning test files missing from LIVE_FILES in scripts/run-ci-tests.mjs: ` +
            `${unregistered.join(", ")}. Register them there (#1248: live suites must stay serial).`,
    );
}

// Parity with the old `npm test` step: its pretest hook builds kernel/ and
// pi-subagents/ dist bundles that the suites import.
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
console.log("[ci-tests] pretest (kernel + pi-subagents build)");
execFileSync(npmCmd, ["run", "pretest"], { cwd: root, stdio: "inherit" });

function runPhase(label, files, concurrency) {
    const t0 = Date.now();
    console.log(`[ci-tests] ${label}: ${files.length} files, concurrency=${concurrency}`);
    try {
        execFileSync(
            process.execPath,
            ["--import", "tsx", "--test", "--test-concurrency", String(concurrency), ...files],
            { cwd: root, stdio: "inherit" },
        );
    } catch {
        console.error(`[ci-tests] ${label} FAILED after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        process.exit(1);
    }
    console.log(`[ci-tests] ${label} ok in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

runPhase("live", LIVE_FILES, 1);
runPhase("pool", allFiles.filter((f) => !LIVE_FILES.includes(f)), 4);
