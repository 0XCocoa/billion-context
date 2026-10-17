// Build gate (#3516 P0): fail if any dist artifact carries a STATIC zod
// import. The published contract (AGENTS.md KDD#1) is that dist/index.js and
// every other entry stay dependency-free — only dist/agent/opencode-native.js
// may use zod, and only via a DYNAMIC import at plugin-tool registration
// (degrades to plain proxy when zod is unresolvable). A static `from "zod"`
// anywhere in dist means the bundler re-linked a transitive dependency into
// the bundle: installs without a node_modules tree (dsh profile bundles, some
// plugin-market copies) then die at startup with ERR_MODULE_NOT_FOUND while
// model traffic silently bypasses compression. The original offender was jimp
// (inlined via noExternal, its internal zod import carried verbatim); it is
// now external + lazily loaded in src/image-rescale.ts. DYNAMIC imports of
// zod are allowed (opencode-native's documented lazy path); static ones are not.

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const STATIC_ZOD = /(?:from\s*["']zod["']|require\(\s*["']zod["']\s*\))/g;

export function findStaticZodRefs(text) {
    const hits = [];
    let m;
    STATIC_ZOD.lastIndex = 0;
    while ((m = STATIC_ZOD.exec(text)) !== null) {
        hits.push(m[0]);
    }
    return hits;
}

export function checkDistNoZod(distDir) {
    const violations = [];
    const walk = (dir) => {
        for (const name of readdirSync(dir)) {
            const full = path.join(dir, name);
            const st = statSync(full);
            if (st.isDirectory()) { walk(full); continue; }
            if (!name.endsWith(".js")) continue;
            const refs = findStaticZodRefs(readFileSync(full, "utf8"));
            if (refs.length > 0) violations.push({ file: full, refs });
        }
    };
    walk(distDir);
    return violations;
}

const invoked = process.argv[1];
const isMain = !!invoked && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(invoked);
if (isMain) {
    const distDir = process.argv[2] ?? "dist";
    const violations = checkDistNoZod(distDir);
    if (violations.length > 0) {
        for (const v of violations) {
            console.error(`dist-no-zod: ${v.file}: ${v.refs.slice(0, 5).join("  ")}${v.refs.length > 5 ? ` … (+${v.refs.length - 5})` : ""}`);
        }
        console.error(`dist-no-zod: FAIL — ${violations.reduce((n, v) => n + v.refs.length, 0)} static zod import(s) across ${violations.length} file(s). Static zod breaks installs without a node_modules tree (ERR_MODULE_NOT_FOUND at startup, silent compression bypass). Keep zod out of the bundle: externalize the offending package and load it dynamically with graceful degradation (see src/image-rescale.ts #3516).`);
        process.exit(1);
    }
    console.log("dist-no-zod: OK");
}
