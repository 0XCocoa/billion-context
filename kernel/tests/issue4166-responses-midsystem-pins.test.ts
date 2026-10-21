import { test } from "node:test";
import assert from "node:assert/strict";
import { responsesToCore, coreToResponses } from "../src/wire/responses.js";
import type { ResponsesRequestBody } from "../src/wire/responses.js";

// #4166 pins: CURRENT responses-wire behavior for mid-conversation
// system/developer items (issue #4159 family, unreported collateral noted in
// #4165). Unlike the openai codec (which keeps mid system as a positioned
// core), responsesToCore hoists EVERY system/developer message item into
// systemParts (→ instructions) regardless of position: position is destroyed
// and structured parts are flattened by messageContent. The #4166 fix keeps
// the leading-prefix hoist but preserves mid items as sidecar cores.

function roundTrip(input: ResponsesRequestBody["input"]) {
  const flat = responsesToCore({ model: "m", input } as ResponsesRequestBody);
  return { flat, rebuilt: coreToResponses(flat.msgs, flat.customToolCallIds) };
}

test("anchor: leading system/developer items hoist into systemParts", () => {
  const { flat } = roundTrip([
    { type: "message", role: "system", content: "head policy" },
    { type: "message", role: "developer", content: "head dev note" },
    { type: "message", role: "user", content: "hi" },
  ]);
  assert.equal(flat.systemParts.length, 2);
  assert.equal(flat.systemParts[0], "head policy");
  assert.equal(flat.systemParts[1], "head dev note");
  assert.equal(flat.msgs.length, 1);
  assert.equal(flat.msgs[0].role, "user");
});

test("pin (current loss): MID system item is hoisted into systemParts, position destroyed", () => {
  const { flat } = roundTrip([
    { type: "message", role: "user", content: "turn 1" },
    { type: "message", role: "user", content: "turn 2" },
    { type: "message", role: "system", content: "mid tool policy" },
    { type: "message", role: "user", content: "turn 3" },
  ]);
  // CURRENT behavior: the mid system item lands in systemParts…
  assert.deepEqual(flat.systemParts, ["mid tool policy"]);
  // …and leaves NO trace at its position in the core array.
  assert.equal(flat.msgs.filter((m) => m.role === "system").length, 0);
  assert.equal(flat.msgs.length, 3);
});

test("pin (current loss): MID system item structured parts are flattened", () => {
  const { flat } = roundTrip([
    { type: "message", role: "user", content: "turn 1" },
    {
      type: "message",
      role: "system",
      content: [
        { type: "input_text", text: "declared tools:" },
        { type: "tool_addition", name: "web_search" } as never,
      ],
    },
    { type: "message", role: "user", content: "turn 2" },
  ]);
  assert.equal(flat.systemParts.length, 1);
  assert.equal(flat.systemParts[0], "declared tools:\n");
  assert.ok(!JSON.stringify(flat).includes("web_search"));
});

test("pin: core system (bili summary carrier path) rebuilds as mid developer", () => {
  const { flat, rebuilt } = roundTrip([
    { type: "message", role: "user", content: "turn 1" },
  ]);
  assert.equal(flat.msgs.length, 1);
  const carrier = {
    id: "raw-carrier",
    role: "system",
    contentType: "text",
    text: "acp_summary: folded 3 messages",
  } as (typeof flat.msgs)[number];
  const out = coreToResponses([...flat.msgs, carrier], flat.customToolCallIds);
  const dev = out.filter(
    (i) =>
      (i as { type?: string; role?: string }).type === "message" &&
      (i as { role?: string }).role === "developer",
  );
  assert.equal(dev.length, 1);
  assert.equal(
    (dev[0] as { content?: string }).content,
    "acp_summary: folded 3 messages",
  );
});
