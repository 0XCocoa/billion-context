import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { CoreMessage } from "acp-kernel";
import { describeCoreTextDuplication, measureCoreTextDuplication } from "../src/preflight.js";

const BLOB = "x".repeat(100);

function core(n: number, text?: string): CoreMessage {
    const base: CoreMessage = { id: `m${n}`, role: "user", contentType: "text" };
    return text === undefined ? base : { ...base, text };
}

test("#4079 repeated core text collapses to one distinct entry", () => {
    const d = measureCoreTextDuplication([core(1, BLOB), core(2, BLOB), core(3, BLOB), core(4, "y".repeat(50))]);
    assert.equal(d.messageCount, 4);
    assert.equal(d.totalBytes, 350);
    assert.equal(d.uniqueBytes, 150);
    assert.equal(d.distinctTexts, 2);
});

test("#4079 empty and missing text is not counted", () => {
    const d = measureCoreTextDuplication([core(1, ""), core(2), core(3, BLOB)]);
    assert.equal(d.messageCount, 1);
    assert.equal(d.totalBytes, 100);
    assert.equal(d.uniqueBytes, 100);
    assert.equal(d.distinctTexts, 1);
});

test("#4079 describe reports the duplicate ratio of a repeated payload", () => {
    const line = describeCoreTextDuplication([core(1, BLOB), core(2, BLOB)]);
    assert.match(line, /2 message\(s\), 200B core over 1 distinct text\(s\), 100B unique, duplicateRatio=0\.500/);
});

test("#4079 describe reports 0.000 for an all-unique payload", () => {
    const line = describeCoreTextDuplication([core(1, BLOB), core(2, "y".repeat(100))]);
    assert.match(line, /duplicateRatio=0\.000/);
});

test("#4079 describe handles an empty core", () => {
    assert.equal(describeCoreTextDuplication([]), "core text is empty");
});
