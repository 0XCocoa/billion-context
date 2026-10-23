import { test } from "node:test";
import assert from "node:assert/strict";
import { anthropicToCore, coreToAnthropic } from "../src/wire/anthropic.js";
import type {
  AnthropicSystemMessage,
  AnthropicWireMessage,
} from "../src/wire/anthropic.js";
import type { BiliMessage } from "../src/wire/bili-message.js";

// #4292: a fold covers the assistant messages that legitimized a client
// mid-conversation system message. Because prune inserts each summary at
// the EARLIEST covered position (kernel/src/prune.ts insertAt), the orphaned
// sidecar system is always IMMEDIATELY followed by the no-sidecar core
// system anchor (rendered summary), which emits as user — producing
// [.., system, user, ..] that Anthropic rejects ("role 'system' must precede
// an 'assistant' message or end the array"), 400ing the session forever.
// coreToAnthropic re-voices exactly that adjacency (the fold signature) to
// user. Everything else emits verbatim: the kernel is transport, not a
// validator, so positionally-illegal client layouts round-trip byte-exact.

function sys(content: AnthropicSystemMessage["content"]): AnthropicSystemMessage {
  return { role: "system", content };
}

/** Indices of system entries that violate the Anthropic position rule
 *  (neither last nor immediately followed by an assistant message). */
function orphans(messages: AnthropicWireMessage[]): number[] {
  const bad: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "system") continue;
    const next = messages[i + 1];
    if (!next || next.role === "assistant") continue;
    bad.push(i);
  }
  return bad;
}

function roundTrip(body: { messages: AnthropicWireMessage[] }) {
  return coreToAnthropic(anthropicToCore(body as never).msgs as never);
}

/** Fold-anchor core: kernel-rendered summary, NO rawAnthropicMessage. */
function anchor(id: string, text: string): BiliMessage {
  return { id, role: "system", contentType: "text", text };
}

const TOOL_ADDITION = {
  type: "tool_addition",
  tool: {
    type: "tool_definition",
    definition: { name: "t", input_schema: { type: "object" } },
  },
};

// --- positive: the fold signature re-voices --------------------------------

test("#4292 shape: sidecar system immediately before the anchor is re-voiced", () => {
  const S = sys([{ type: "text", text: "tools updated mid-session" }]);
  const { msgs } = anthropicToCore({
    messages: [
      { role: "user", content: "q1" },
      S,
      { role: "assistant", content: [{ type: "text", text: "gone" }] },
    ],
  } as never);
  // The fold covered the assistant; the anchor took its earliest position.
  const rebuilt = coreToAnthropic([
    msgs[0] as BiliMessage,
    msgs[1] as BiliMessage,
    anchor("a1", "[Compressed conversation section] gone turn"),
    { id: "t1", role: "user", contentType: "text", text: "next question" },
  ] as never);
  assert.deepEqual(orphans(rebuilt), []);
  assert.equal(rebuilt[1]!.role, "user");
  // Only the role changed — content blocks stay byte-identical.
  assert.deepEqual(rebuilt[1]!.content, S.content);
  // Anchor + tail keep their user mapping, text verbatim.
  assert.deepEqual(rebuilt[2], {
    role: "user",
    content: [
      { type: "text", text: "[Compressed conversation section] gone turn" },
      { type: "text", text: "next question" },
    ],
  });
});

test("consecutive orphaned systems before the anchor re-voice as a whole run", () => {
  const S1 = sys([{ type: "text", text: "first" }]);
  const S2 = sys([
    { type: "text", text: "second" },
    TOOL_ADDITION,
  ]);
  const rebuilt = coreToAnthropic([
    { id: "u0", role: "user", contentType: "text", text: "q1" },
    { id: "s1", role: "system", contentType: "text", text: "first", rawAnthropicMessage: S1 },
    { id: "s2", role: "system", contentType: "text", text: "second", rawAnthropicMessage: S2 },
    anchor("a1", "[Compressed conversation section] folded"),
    { id: "t1", role: "user", contentType: "text", text: "next" },
  ] as never);
  assert.deepEqual(orphans(rebuilt), []);
  assert.equal(rebuilt[1]!.role, "user");
  assert.deepEqual(rebuilt[1]!.content, S1.content);
  assert.equal(rebuilt[2]!.role, "user");
  assert.deepEqual(rebuilt[2]!.content, S2.content);
  assert.deepEqual(rebuilt[3], {
    role: "user",
    content: [
      { type: "text", text: "[Compressed conversation section] folded" },
      { type: "text", text: "next" },
    ],
  });
});

test("re-voicing substitutes fresh objects; the stored sidecar is never mutated", () => {
  const S = sys([{ type: "text", text: "delta" }]);
  const sidecarCore: BiliMessage = {
    id: "s1",
    role: "system",
    contentType: "text",
    text: "delta",
    rawAnthropicMessage: S,
  };
  const rebuilt = coreToAnthropic([
    sidecarCore,
    anchor("a1", "[Compressed conversation section] x"),
  ] as never);
  assert.equal(rebuilt[0]!.role, "user");
  assert.equal(S.role, "system");
  assert.equal(sidecarCore.rawAnthropicMessage, S);
});

// --- negative: everything else emits verbatim ------------------------------

test("Pi shape: system run at array end (no anchor after) round-trips verbatim", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "a" }] },
    sys([{ type: "text", text: "tools" }, TOOL_ADDITION]),
    sys([{ type: "text", text: "trailing effort" }]),
  ] as AnthropicWireMessage[];
  assert.deepEqual(roundTrip({ messages }), messages);
});

test("sidecar system followed by a plain user message stays verbatim", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "a" }] },
    sys([{ type: "text", text: "between user turns" }]),
    { role: "user", content: [{ type: "text", text: "b" }] },
  ] as AnthropicWireMessage[];
  assert.deepEqual(roundTrip({ messages }), messages);
});

test("sidecar system immediately followed by an assistant stays verbatim", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "a" }] },
    sys([{ type: "text", text: "policy update" }]),
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
  ] as AnthropicWireMessage[];
  assert.deepEqual(roundTrip({ messages }), messages);
});

test("sidecar system at array end stays verbatim", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "a" }] },
    sys([{ type: "text", text: "# Environment\n - Platform: linux" }]),
  ] as AnthropicWireMessage[];
  assert.deepEqual(roundTrip({ messages }), messages);
});

test("directive-only system adjacent to the anchor stays system (legal anywhere)", () => {
  // Re-voicing a pure effort marker would mint an empty-content user that 400s alone.
  const dir = { role: "system", content: [], output_config: { effort: "high" } } as unknown as AnthropicSystemMessage;
  const rebuilt = coreToAnthropic([
    { id: "u0", role: "user", contentType: "text", text: "q1" },
    { id: "s1", role: "system", contentType: "text", text: "[effort]", rawAnthropicMessage: dir },
    anchor("a1", "[Compressed conversation section] x"),
  ] as never);
  assert.equal(rebuilt[1]!.role, "system");
  assert.deepEqual(rebuilt[1]!.content, []);
  assert.equal(rebuilt[2]!.role, "user");
});

test("run separated from a later anchor by a user core stays verbatim", () => {
  // The anchor adjacency must be immediate: a user core between the system
  // and the anchor means the system was NOT orphaned by that fold.
  const rebuilt = coreToAnthropic([
    { id: "u0", role: "user", contentType: "text", text: "q1" },
    { id: "s1", role: "system", contentType: "text", text: "mid", rawAnthropicMessage: sys("mid") },
    { id: "u1", role: "user", contentType: "text", text: "gap" },
    anchor("a1", "[Compressed conversation section] x"),
  ] as never);
  assert.equal(rebuilt[1]!.role, "system");
  assert.deepEqual(rebuilt[1], sys("mid"));
});

test("sidecar system before an assistant and a later anchor stays verbatim", () => {
  const rebuilt = coreToAnthropic([
    { id: "s1", role: "system", contentType: "text", text: "mid", rawAnthropicMessage: sys("mid") },
    { id: "a0", role: "assistant", contentType: "text", text: "ok" },
    anchor("a1", "[Compressed conversation section] x"),
  ] as never);
  assert.equal(rebuilt[0]!.role, "system");
});

test("anchor with no preceding systems re-voices nothing", () => {
  assert.deepEqual(
    coreToAnthropic([anchor("a1", "[Compressed conversation section] x")] as never),
    [
      {
        role: "user",
        content: [{ type: "text", text: "[Compressed conversation section] x" }],
      },
    ],
  );
  const rebuilt = coreToAnthropic([
    { id: "u0", role: "user", contentType: "text", text: "q1" },
    anchor("a1", "[Compressed conversation section] x"),
  ] as never);
  assert.deepEqual(rebuilt, [
    {
      role: "user",
      content: [
        { type: "text", text: "q1" },
        { type: "text", text: "[Compressed conversation section] x" },
      ],
    },
  ]);
});

test("edge arrays are unaffected: empty, user-only, assistant-only", () => {
  assert.deepEqual(coreToAnthropic([]), []);
  assert.deepEqual(
    coreToAnthropic([
      { id: "u1", role: "user", contentType: "text", text: "hi" },
    ] as never),
    [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  );
  assert.deepEqual(
    coreToAnthropic([
      { id: "a1", role: "assistant", contentType: "text", text: "hey" },
    ] as never),
    [{ role: "assistant", content: [{ type: "text", text: "hey" }] }],
  );
});
