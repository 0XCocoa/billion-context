// #3029/#3665/#4347: pure classifiers for the TAP output of a FAILED `node --test`
// phase. Extracted from run-ci-tests.mjs so the retry decision is unit-tested
// without spawning the suite (same precedent as scripts/live-files.mjs, #3182);
// the runner stays the only place these feed a process.exit.
//
// Four shapes, in priority order:
//   'swallowed'      — a top-level `not ok <file.test.ts>` whose only payload is
//                      `error: 'test failed'`: the child DIED silently (OOM kill,
//                      worker death, race exit under concurrency) and node --test
//                      collapsed it to one file-level entry with zero subtests.
//                      Recoverable via isolated re-run + one full retry (#3029).
//   'cancelled-drain'— TAP tail says fail=0 but cancelled>0: every loss is an
//                      event-loop-drain cancellation ("Promise resolution is still
//                      pending but the event loop has already resolved"). ZERO
//                      assertions failed, so this is an infrastructure-level
//                      drain (runner contamination OR a deterministic in-process
//                      hang — root cause still open under #3665), not an
//                      assertion regression. One full retry; a reproduced
//                      signature means the condition persists on this runner.
//   'cleanup-lock'   — every failing subtest carries an OS transient-lock errno
//                      on an unlink/rmdir inside a rimraf teardown stack: the
//                      #2799/#2908/#4347 family, where Windows AV/indexer
//                      briefly locks a freshly-written index.db past tests/
//                      tmp-rm.ts' ~9.6s retry ladder. An EBUSY unlink is never
//                      an assertion regression; one full retry, and a
//                      DETERMINISTIC lock (e.g. a genuine handle leak) reproduces
//                      on the retry and still fails — same no-masking guarantee.
//   'concrete'       — anything else (real assertion failures, missing TAP tail):
//                      fail hard, never retried. A deterministic hang reproduces on
//                      the retry and still fails, so the bounded retry cannot mask
//                      a genuine regression either way.

// A top-level `not ok N - <path ending .test.ts>` can only come from a file
// whose child died: successful files promote their inner tests to top level by
// test name and never emit a file-level entry. Pairing that with the YAML
// `error: 'test failed'` marker isolates the swallowed/silent-death shape from
// real assertion failures (named by test name, carrying a real message).
export function extractSwallowedFiles(output, baseToFile) {
    const lines = output.split(/\r?\n/);
    const found = new Set();
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^not ok \d+ - (.+?)\s*$/);
        if (!m) continue;
        const window = lines.slice(i, i + 20).join("\n");
        if (!/error:\s*'test failed'/.test(window)) continue;
        const base = m[1].trim().split(/[\\/]/).pop();
        const rel = baseToFile.get(base);
        if (rel) found.add(rel);
    }
    return [...found];
}

// The tap reporter ends every run with column-0 comment lines:
//   # pass N / # fail N / # cancelled N / # skipped N / # todo N / # duration_ms N
// Nested test detail is always indented, so a column-0 `# <label> <int>` pair can
// only be reporter metadata. Returns null when the summary is absent at all
// (the child died before emitting it) — callers must treat that as "no evidence".
export function extractTapCounts(output) {
    const count = (label) => {
        const m = output.match(new RegExp(`^# ${label} (\\d+)\\s*$`, "m"));
        return m ? Number(m[1]) : null;
    };
    const pass = count("pass");
    const fail = count("fail");
    const cancelled = count("cancelled");
    if (pass === null || fail === null) return null;
    return { pass, fail, cancelled: cancelled ?? 0 };
}

// The exact errno set tests/tmp-rm.ts itself treats as transient-plus-retryable
// (#1910/#2908), pinned to teardown deletes (unlink/rmdir) whose stack goes
// through Node's internal rimraf — i.e. an rmSync({recursive}) teardown, the
// tmp-rm family. A raw user-code unlinkSync EBUSY (a plausible REAL handle-leak
// regression in src) carries no rimraf frames and stays concrete, unretired.
const TRANSIENT_LOCK_ERROR =
    /error:\s*["']?(EBUSY|EPERM|EACCES|ENOTEMPTY|EMFILE): [^"']*\b(unlink|rmdir)/;

// Walks every column-0 `not ok` entry (skips `# SKIP` directives — a skipped
// not-ok is not a failure) and splits them into teardown-lock failures vs
// everything else. The YAML detail block of one entry ends where the next
// `ok`/`not ok` line starts, so the error lookup can never bleed into a
// neighbor entry.
export function countNotOkEntries(output) {
    const lines = output.split(/\r?\n/);
    let lock = 0;
    let other = 0;
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^not ok \d+ - (.+?)(\s+# SKIP.*)?\s*$/);
        if (!m) continue;
        if (m[2]) continue; // a skipped not-ok is not a failure
        let j = i + 1;
        const block = [];
        while (j < lines.length && !/^(not )?ok \d+ - /.test(lines[j]) && j - i <= 30) {
            block.push(lines[j]);
            j++;
        }
        const text = block.join("\n");
        if (TRANSIENT_LOCK_ERROR.test(text) && /rimraf/.test(text)) lock++;
        else other++;
    }
    return { lock, other };
}

export function classifyPhaseFailure(output, baseToFile) {
    const swallowed = extractSwallowedFiles(output, baseToFile);
    if (swallowed.length > 0) return { kind: "swallowed", files: swallowed };
    const counts = extractTapCounts(output);
    if (counts !== null && counts.fail === 0 && counts.cancelled > 0) {
        return { kind: "cancelled-drain", counts };
    }
    const entries = countNotOkEntries(output);
    if (entries.lock > 0 && entries.other === 0) {
        return { kind: "cleanup-lock", locks: entries.lock };
    }
    return { kind: "concrete", counts };
}

// The retry runs on the SAME runner as the first phase, so what its output
// reclassifies to changes the conclusion: the same drain signature means the
// condition persists on this machine (a fresh runner is the only escape), while
// concrete/swallowed failures on the retry are genuine regressions. The caller
// must never print a fixed "genuine failure" line without reclassifying — that
// mislabels a reproduced drain as a code regression (#3665 round-2 log).
export function describeRetryOutcome(verdict) {
    if (verdict.kind === "cancelled-drain") {
        return (
            `retry on the SAME runner reproduced the identical zero-assertion-failure drain ` +
            `signature (pass=${verdict.counts.pass} fail=0 cancelled=${verdict.counts.cancelled}) -> ` +
            `persistent condition on this runner (machine state or deterministic in-process hang), ` +
            `bounded retry exhausted; rerunning the job draws a fresh runner (#3665)`
        );
    }
    if (verdict.kind === "cleanup-lock") {
        return (
            `retry on the SAME runner reproduced ${verdict.locks} teardown-lock failure(s) -> either a ` +
            `persistent external lock (AV/indexer) on this runner or a DETERMINISTIC handle leak in ` +
            `the code; rerunning the job draws a fresh runner, and if the lock reproduces there too ` +
            `the leaked-handle hypothesis is primary (#4347)`
        );
    }
    if (verdict.kind === "swallowed") {
        return `retry failed again on the swallowed shape (${verdict.files.join(", ")}) -> genuine failure, not a flake`;
    }
    const c = verdict.counts;
    if (c !== null && c.fail > 0) {
        return `retry produced ${c.fail} concrete assertion failure(s) -> genuine failure, not a flake`;
    }
    return "retry failed without a recognizable TAP failure shape -> genuine failure, not a flake";
}
