import { test } from "node:test";
import assert from "node:assert/strict";
import { anthropicToCore, coreToAnthropic } from "../src/wire/anthropic.js";
import {
  hasMediaPayload,
  hasUnrecoverableMediaPayload,
} from "../src/protected.js";

// Pi (supportsMidConvoToolChanges) declares tools added mid-session as
// `tool_addition` blocks inside mid-conversation `role:"system"` messages,
// and emits empty system messages carrying message-level `output_config`.
// anthropicToCore used to split those into the user/assistant block stream
// and coreToAnthropic re-emitted them as `user` — on 0.1.202 the blocks were
// dropped (tools never reached the model); after #3410 they survived but
// upstream rejected them: "'tool_addition'/'tool_removal' blocks are only
// permitted within `role: \"system\"` messages".

const TOOL_ADDITION = {
  type: "tool_addition",
  tool: {
    type: "tool_definition",
    definition: {
      name: "subagent",
      description: "Delegate to subagents",
      input_schema: { type: "object", properties: {} },
    },
  },
};

const EFFORT = {
  role: "system",
  content: [],
  output_config: { effort: "medium" },
};

const TOOLS_DELTA = {
  role: "system",
  content: [
    {
      type: "text",
      text: 'Updated system prompt section "tools":\n<tools>…</tools>',
    },
    TOOL_ADDITION,
  ],
};

function piBody() {
  return {
    messages: [
      { role: "user", content: [{ type: "text", text: "enable subagents" }] },
      EFFORT,
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "subagents_enable",
            input: {},
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: "Enabled: subagent.",
          },
        ],
      },
      TOOLS_DELTA,
      EFFORT,
    ],
  };
}

test("round-trips pi mid-conversation system messages byte-exact", () => {
  const body = piBody();
  const rebuilt = coreToAnthropic(anthropicToCore(body as never).msgs as never);
  assert.deepEqual(rebuilt, body.messages);
});

test("one core per system wire message, role system, wireIndex kept", () => {
  const msgs = anthropicToCore(piBody() as never).msgs as {
    [k: string]: unknown;
  }[];
  const systems = msgs.filter((m) => m.rawAnthropicMessage !== undefined);
  assert.deepEqual(
    systems.map((m) => [m.role, m.wireIndex]),
    [
      ["system", 1],
      ["system", 4],
      ["system", 5],
    ],
  );
  assert.equal(systems[0]!.text, "[system]");
  assert.match(
    systems[1]!.text as string,
    /^Updated system prompt section "tools":/,
  );
  assert.match(systems[1]!.text as string, /\[tool_addition\]$/);
});

test("system message between two user turns does not merge them", () => {
  const body = {
    messages: [
      { role: "user", content: [{ type: "text", text: "a" }] },
      TOOLS_DELTA,
      { role: "user", content: [{ type: "text", text: "b" }] },
    ],
  };
  const rebuilt = coreToAnthropic(anthropicToCore(body as never).msgs as never);
  assert.deepEqual(rebuilt, body.messages);
});

test("string-content system message round-trips", () => {
  const body = {
    messages: [
      { role: "user", content: "hi" },
      { role: "system", content: "be brief" },
    ],
  };
  const rebuilt = coreToAnthropic(anthropicToCore(body as never).msgs as never);
  assert.deepEqual(rebuilt[1], { role: "system", content: "be brief" });
});

test("kernel-synthesized system cores (no sidecar) still map to user", () => {
  const rebuilt = coreToAnthropic([
    {
      id: "s1",
      role: "system",
      contentType: "text",
      text: "[Compressed conversation section] x",
    },
  ] as never);
  assert.deepEqual(rebuilt, [
    {
      role: "user",
      content: [{ type: "text", text: "[Compressed conversation section] x" }],
    },
  ]);
});

test("system-message cores are never folded; plain text cores still are", () => {
  const msgs = anthropicToCore(piBody() as never).msgs;
  for (const m of msgs) {
    const sidecar = (m as { rawAnthropicMessage?: unknown })
      .rawAnthropicMessage;
    assert.equal(hasUnrecoverableMediaPayload(m), sidecar !== undefined, m.id);
  }
  assert.equal(hasMediaPayload(msgs[0]!), false);
});

test("ids are deterministic; identical system messages stay distinct", () => {
  const ids = () => anthropicToCore(piBody() as never).msgs.map((m) => m.id);
  assert.deepEqual(ids(), ids());
  const msgs = anthropicToCore(piBody() as never).msgs as {
    [k: string]: unknown;
  }[];
  const effortIds = msgs.filter((m) => m.text === "[system]").map((m) => m.id);
  assert.equal(effortIds.length, 2);
  assert.notEqual(effortIds[0], effortIds[1]);
});

test("parse is a structural fixed point over rebuild", () => {
  const first = anthropicToCore(piBody() as never).msgs;
  const rebuilt = coreToAnthropic(first as never);
  const second = anthropicToCore({ messages: rebuilt } as never).msgs;
  assert.deepEqual(second, first);
});
