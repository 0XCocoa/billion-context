// #2813: read-only failure diagnostics. Runs only when a CI job fails (see the
// `if: failure()` + continue-on-error step in .github/workflows/ci.yml), capturing
// the resource/concurrency context so the three known load-sensitive flakes
// (fork-adoption-wires / issue2033-anonymous-anchor / issue2601-persona-fork-lineage)
// can be attributed to runner degradation (CPU steal / memory pressure) vs a genuine
// regression. Cross-platform safe; never throws.
import os from "node:os";
import fs from "node:fs";

const mb = (n) => Math.round(n / 1048576);
let nodeProcs = "n/a";
try {
  nodeProcs = fs.readdirSync("/proc").filter((d) => {
    if (!/^\d+$/.test(d)) return false;
    try { return fs.readFileSync(`/proc/${d}/comm`, "utf8").trim() === "node"; } catch { return false; }
  }).length;
} catch {}

console.log(
  "[#2813 diag] " +
  `cpus=${os.cpus().length}` +
  ` loadavg=${JSON.stringify(os.loadavg())}` +
  ` totalMemMB=${mb(os.totalmem())}` +
  ` freeMemMB=${mb(os.freemem())}` +
  ` nodeProcs=${nodeProcs}`,
);
