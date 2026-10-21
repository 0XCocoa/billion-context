import { test } from "node:test";
import assert from "node:assert/strict";
import { openaiToCore, coreToOpenai } from "../src/wire/openai.js";
import type { OpenAIRequestBody } from "../src/wire/openai.js";

// #4166 pins: CURRENT openai-wire behavior for mid-conversation system
// messages (issue #4159 family). These pins document today's codec contract
// BEFORE the verbatim-sidecar change lands; the fix flips the "loss" pins
// and keeps the anchors. Anthropic lane precedent: #3992
// (rawAnthropicMessage sidecar); openai lane has no equivalent yet — mid
// system is text-flattened by stringContent and rebuilt text-only.

function roundTrip(messages: OpenAIRequestBody["messages"]) {
  const flat = openaiToCore({ model: "m", messages } as OpenAIRequestBody);
  return { flat, rebuilt: coreToOpenai(flat.msgs) };
}

test("anchor: leading system stays hoisted (unchanged by #4166)", () => {
  const { flat, rebuilt } = roundTrip([
    { role: "system", content: "head policy" },
    { role: "user", content: "hi" },
  ]);
  assert.equal(flat.systemText, "head policy");
  assert.equal(flat.msgs.length, 1);
  assert.equal(flat.msgs[0].role, "user");
  // Head re-injection is the HOST step (injectOpenaiSystem): the codec-level
  // rebuild only carries the conversation cores — pinned here so the
  // leading-hoist anchor covers codec + host seam.
  assert.equal(rebuilt[0].role, "user");
  assert.equal(rebuilt.filter((m) => m.role === "system").length, 0);
});

test("pin: mid system (plain string) keeps position and role as text-only core", () => {
  const { flat, rebuilt } = roundTrip([
    { role: "user", content: "turn 1" },
    { role: "assistant", content: "answer 1" },
    { role: "system", content: "tool_addition text policy" },
    { role: "user", content: "turn 2" },
  ]);
  const mid = flat.msgs.find((m) => m.role === "system");
  assert.ok(mid, "mid system survives as a core");
  assert.equal(mid.contentType, "text");
  assert.equal(mid.text, "tool_addition text policy");
  assert.equal(mid.originalRole, "system");
  const rb = rebuilt.find(
    (m) => m.role === "system" || m.role === "developer",
  );
  assert.ok(rb, "rebuilt as a system-family message");
  assert.equal(rb.role, "system");
  assert.equal(rb.content, "tool_addition text policy");
  assert.ok(rebuilt.indexOf(rb) > 0, "position preserved (not hoisted to head)");
});

test("pin (current loss): mid system structured blocks are dropped by stringContent", () => {
  const { flat, rebuilt } = roundTrip([
    { role: "user", content: "turn 1" },
    {
      role: "system",
      content: [
        { type: "text", text: "declared tools:" },
        {
          type: "tool_addition",
          name: "web_search",
          spec: { enabled: true },
        } as never,
      ],
    },
    { role: "user", content: "turn 2" },
  ]);
  const mid = flat.msgs.find((m) => m.role === "system");
  assert.ok(mid);
  // CURRENT behavior: only string / {type:"text"} parts survive the
  // flatten — non-text parts become "" and join with "\n".
  assert.equal(mid.text, "declared tools:\n");
  assert.equal(mid.contentType, "text");
  const rb = rebuilt.filter(
    (m) => m.role === "system" || m.role === "developer",
  );
  assert.equal(rb.length, 1);
  const out = rb[0].content;
  assert.equal(typeof out, "string");
  assert.ok(!JSON.stringify(out).includes("web_search"), "block bytes are gone on the wire out");
  assert.ok(!JSON.stringify(out).includes("tool_addition"));
});

test("pin: mid developer is preserved as system-core with originalRole developer", () => {
  const { flat, rebuilt } = roundTrip([
    { role: "user", content: "q" },
    { role: "developer", content: "mid dev note" },
    { role: "user", content: "r" },
  ]);
  const mid = flat.msgs.find((m) => m.role === "system");
  assert.ok(mid);
  assert.equal(mid.originalRole, "developer");
  const rb = rebuilt.find((m) => m.role === "developer");
  assert.ok(rb, "developer role round-trips");
  assert.equal(rb.content, "mid dev note");
});
