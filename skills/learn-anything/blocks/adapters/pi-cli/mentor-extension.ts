import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const surfaceOperation = Type.Object({
  kind: StringEnum(["create_surface", "update_components", "update_data_model", "delete_surface"] as const),
  surface_id: Type.String({ minLength: 1, maxLength: 200 }),
  catalog_id: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  components: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()), { minItems: 1, maxItems: 100 })),
  path: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  value: Type.Optional(Type.Unknown()),
}, { additionalProperties: false });

const completeMentorTurn = defineTool({
  name: "complete_mentor_turn",
  label: "Complete mentor turn",
  description: "Return the final learner-facing mentor answer and optional structured browser surface plan.",
  promptSnippet: "Complete the browser mentor turn through one validated structured result",
  promptGuidelines: [
    "Call complete_mentor_turn exactly once as the final action for every learner event.",
    "Put learner-facing prose in message. Never print or embed JSON, JSONL, protocol envelopes, or adapter diagnostics in message.",
    "Use presentation chat for broad questions, inline only for an explicitly anchored component question, and activity for visible learner work or submitted results. For activity, task_title names the one current task in the learner's language.",
    "Return question continuation for chat and action continuation for inline/activity. The text is one short sentence in the learner's language; a work action names the visible target and exact thing to do now.",
    "Keep one active task. Place its instruction immediately before its target; supporting explanation and feedback follow it.",
    "Omit surface_plan when the current canvas should remain unchanged. Use structured operations instead of JSON strings when changing the canvas.",
  ],
  parameters: Type.Object({
    message: Type.String({ minLength: 1, maxLength: 20_000 }),
    presentation: StringEnum(["chat", "inline", "activity"] as const),
    task_title: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    continuation: Type.Object({
      kind: StringEnum(["question", "action"] as const),
      text: Type.String({ minLength: 1, maxLength: 280 }),
      action_type: Type.Optional(StringEnum(["run", "edit", "answer", "adjust", "read", "inspect", "submit"] as const)),
    }, { additionalProperties: false }),
    target_component_id: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    target_quote: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
    surface_plan: Type.Optional(Type.Object({
      operations: Type.Array(surfaceOperation, { maxItems: 100 }),
    }, { additionalProperties: false })),
  }, { additionalProperties: false }),
  constrainedSampling: { type: "json_schema", strict: "prefer" as const },

  async execute(_toolCallId, params) {
    return {
      content: [{ type: "text" as const, text: "Mentor turn prepared for browser commit." }],
      details: { contractVersion: 1, ...params },
      terminate: true,
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(completeMentorTurn);
}
