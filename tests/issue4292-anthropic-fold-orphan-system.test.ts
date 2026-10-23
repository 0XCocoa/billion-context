import { test } from "node:test";
import assert from "node:assert/strict";
import {
  anthropicToCore,
  coreToAnthropic,
  type AnthropicBlock,
  type AnthropicSystemMessage,
  type AnthropicWireMessage,
} from "acp-kernel/wire";
import type { BiliMessage } from "acp-kernel/wire";

// #4292: v0.1.204 (#3991) made client mid-conversation Anthropic
// `role:"system"` messages re-emit verbatim in place, but a compression fold
// can cover the assistant messages that legitimized such a message. Because
// prune inserts the summary at the EARLIEST covered position, the orphaned
// system is always immediately followed by the anchor (a no-sidecar core
// system emitting as user) — [.., system, user, ..] makes Anthropic 400 the
// session permanently (`messages.N: role 'system' must precede an 'assistant'
// message or end the array`). coreToAnthropic re-voices exactly that fold
// signature to user; every other client layout stays byte-exact.

/** Indices of system entries violating the Anthropic position rule. */
function orphanSystems(messages: AnthropicWireMessage[]): number[] {
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

const CLIENT_SYSTEM: AnthropicSystemMessage = {
  role: "system",
  content: [
    {
      type: "text",
      text: 'Updated system prompt section "tools":\n<tools>…</tools>',
    },
    // tool_addition is not in the typed AnthropicBlock union (it is a
    // system-messages-beta block); the fixture keeps it structurally real.
    {
      type: "tool_addition",
      tool: {
        type: "tool_definition",
        definition: {
          name: "subagent",
          input_schema: { type: "object", properties: {} },
        },
      },
    } as unknown as AnthropicBlock,
  ],
};

const ANCHOR_TEXT = "[Compressed conversation section] early turns folded";

// Pre-fold history: the client system was immediately followed by an
// assistant, so the verbatim re-emission was legal.
const preFoldWire = [
  { role: "user", content: [{ type: "text", text: "enable subagents" }] },
  CLIENT_SYSTEM,
  { role: "assistant", content: [{ type: "text", text: "subagents enabled" }] },
  { role: "user", content: [{ type: "text", text: "run one" }] },
  { role: "assistant", content: [{ type: "text", text: "done" }] },
] as AnthropicWireMessage[];

/** Post-fold core list: the fold covered everything after the client system;
 *  the kernel-rendered anchor (no sidecar) sits at the earliest covered
 *  position — immediately after the orphaned system. */
function postFoldCore(): BiliMessage[] {
  const { msgs } = anthropicToCore({ messages: preFoldWire } as never);
  return [
    msgs[0] as BiliMessage, // user: "enable subagents"
    msgs[1] as BiliMessage, // sidecar system (CLIENT_SYSTEM)
    { id: "anchor", role: "system", contentType: "text", text: ANCHOR_TEXT },
    { id: "tail", role: "user", contentType: "text", text: "next question" },
  ];
}

test("pre-fold wire round-trips byte-identical (no fold, no re-voicing)", () => {
  const { msgs } = anthropicToCore({ messages: preFoldWire } as never);
  const rebuilt = coreToAnthropic(msgs as never);
  assert.deepEqual(rebuilt, preFoldWire);
  assert.deepEqual(orphanSystems(rebuilt), []);
});

test("without the anchor adjacent, the orphaned system would stay system (documents #4292)", () => {
  // The fold covered a DIFFERENT region: the client system keeps its
  // verbatim system emission even though the assistants around it are gone.
  // That emission is what Anthropic rejects — the kernel only re-voices the
  // anchor-adjacency signature, so this shape is the host's to avoid.
  const cores = postFoldCore().filter((m) => m.id !== "anchor");
  const rebuilt = coreToAnthropic(cores as never);
  assert.equal(rebuilt[1]!.role, "system");
  assert.deepEqual(rebuilt[1]!.content, CLIENT_SYSTEM.content);
  assert.deepEqual(orphanSystems(rebuilt), [1]);
});

test("post-fold: anchor adjacency re-voices the orphan, bytes preserved", () => {
  const cores = postFoldCore();
  const rebuilt = coreToAnthropic(cores as never);
  assert.deepEqual(
    orphanSystems(rebuilt),
    [],
    "no illegal-position system remains after the fold guard",
  );
  // The orphaned system became a user message with byte-identical blocks.
  assert.equal(rebuilt[1]!.role, "user");
  assert.deepEqual(rebuilt[1]!.content, CLIENT_SYSTEM.content);
  // Anchor + tail keep their user mapping with verbatim text.
  assert.deepEqual(rebuilt[2], {
    role: "user",
    content: [
      { type: "text", text: ANCHOR_TEXT },
      { type: "text", text: "next question" },
    ],
  });
  // The session-stored sidecar object was not mutated by the re-voicing.
  assert.equal(
    (cores[1]!.rawAnthropicMessage as AnthropicSystemMessage).role,
    "system",
  );
});

test("post-fold with a surviving assistant after the anchor stays fully legal", () => {
  const cores = postFoldCore();
  cores.push({
    id: "a2",
    role: "assistant",
    contentType: "text",
    text: "final answer",
  });
  const rebuilt = coreToAnthropic(cores as never);
  assert.deepEqual(orphanSystems(rebuilt), []);
  assert.equal(rebuilt[1]!.role, "user");
  assert.deepEqual(rebuilt[3], {
    role: "assistant",
    content: [{ type: "text", text: "final answer" }],
  });
});

test("Pi-style trailing system run (no anchor) stays verbatim end-to-end", () => {
  // Pi emits [.., system(tool delta), system(output_config)] at the end of
  // the array; re-voicing those would resurrect the #3410-era rejection
  // ("tool_addition blocks are only permitted within role:system messages").
  const wire = [
    { role: "user", content: [{ type: "text", text: "enable subagents" }] },
    CLIENT_SYSTEM,
    { role: "system", content: [], output_config: { effort: "medium" } },
  ] as AnthropicWireMessage[];
  const { msgs } = anthropicToCore({ messages: wire } as never);
  const rebuilt = coreToAnthropic(msgs as never);
  assert.deepEqual(rebuilt, wire);
});
