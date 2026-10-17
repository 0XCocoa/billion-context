// Build-gate tests (scripts/check-dist-no-zod.mjs): the gate must catch
// static zod imports in any dist artifact (minified or spaced, ESM or CJS)
// while passing dynamic import("zod") — opencode-native's documented lazy
// path — and clean bundles. #3516 P0: the original offender was jimp's
// transitive `import { z } from "zod"` carried verbatim into dist/index.js.

import { test } from "node:test";
import assert from "node:assert/strict";
const gateSpec = "../scripts/check-dist-no-zod.mjs";
const { findStaticZodRefs, checkDistNoZod } = await import(gateSpec) as {
    findStaticZodRefs: (text: string) => string[];
    checkDistNoZod: (distDir: string) => Array<{ file: string; refs: string[] }>;
};
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmrf } from "./tmp-rm.ts";

test("findStaticZodRefs catches static ESM and CJS zod imports, minified or spaced", () => {
    const bad = [
        'import { z } from"zod";',
        'import z from "zod";',
        "import * as z from 'zod';",
        'require("zod")',
        "require( 'zod' )",
    ].join("\n");
    const refs = findStaticZodRefs(bad);
    assert.equal(refs.length, 5);
});

test("findStaticZodRefs passes dynamic imports and non-zod specifiers", () => {
    const good = [
        "const m = await import('zod');",
        'const n = import("zod").then((x) => x.z);',
        'from"jimp"',
        'import { Jimp } from "jimp";',
        'require("node:crypto")',
    ].join("\n");
    assert.deepEqual(findStaticZodRefs(good), []);
});

test("checkDistNoZod walks dist recursively and reports per file", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-distnozod-"));
    try {
        mkdirSync(path.join(root, "agent"), { recursive: true });
        writeFileSync(path.join(root, "index.js"), "export default 1;\n");
        writeFileSync(path.join(root, "agent", "pi-native.js"), 'import { z } from"zod";\n');
        writeFileSync(path.join(root, "agent", "opencode-native.js"), "const z = await import('zod');\n");
        const violations = checkDistNoZod(root);
        assert.equal(violations.length, 1);
        assert.ok(violations[0].file.endsWith(path.join("agent", "pi-native.js")));
        assert.equal(violations[0].refs.length, 1);
    } finally {
        rmrf(root);
    }
});
