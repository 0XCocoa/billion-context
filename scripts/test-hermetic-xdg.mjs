// #2813: hermetic test isolation. Loaded via `--import` before every test file
// so each `node --test` subprocess gets its own private XDG dirs instead of all
// concurrently-running suites sharing ~/.local/state|cache|data|config/billion-context.
// Set only when unset: tests that pin their own mkdtemp XDG dir still win, and any
// externally-provided XDG_* (e.g. CI) is respected. Deliberately no teardown —
// matching the existing mkdtemp-without-cleanup precedent (tests/issue2601-*);
// the dirs are empty/tiny and OS temp reaping handles them.
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "bili-test-xdg-"));
for (const key of ["XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME"]) {
  if (!process.env[key]) process.env[key] = join(root, key.toLowerCase());
}
