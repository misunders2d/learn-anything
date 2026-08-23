export function createClaudeEventState() {
  return {
    apiMessageId: null,
    textBlocks: new Map(),
    toolBlocks: new Map(),
  };
}

export function mapClaudeMessage(message, state = createClaudeEventState()) {
  const output = [];

  if (message.type === "system" && message.subtype === "init" && message.session_id) {
    output.push({ type: "CUSTOM", name: "mentor_session", value: { sessionId: message.session_id } });
    return output;
  }

  if (message.type === "stream_event") {
    const event = message.event || {};
    const index = event.index ?? 0;
    if (event.type === "message_start") {
      state.apiMessageId = event.message?.id || message.uuid;
    } else if (event.type === "content_block_start") {
      const block = event.content_block || {};
      if (block.type === "text") {
        const messageId = `${state.apiMessageId || message.uuid}:text:${index}`;
        state.textBlocks.set(index, messageId);
        output.push({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" });
        if (block.text) output.push({ type: "TEXT_MESSAGE_CONTENT", messageId, delta: block.text });
      } else if (block.type === "tool_use") {
        state.toolBlocks.set(index, block.id);
        output.push({ type: "TOOL_CALL_START", toolCallId: block.id, toolCallName: block.name });
      }
    } else if (event.type === "content_block_delta") {
      if (event.delta?.type === "text_delta") {
        const messageId = state.textBlocks.get(index);
        if (messageId) output.push({ type: "TEXT_MESSAGE_CONTENT", messageId, delta: event.delta.text || "" });
      } else if (event.delta?.type === "input_json_delta") {
        const toolCallId = state.toolBlocks.get(index);
        if (toolCallId) output.push({ type: "TOOL_CALL_ARGS", toolCallId, delta: event.delta.partial_json || "" });
      }
    } else if (event.type === "content_block_stop") {
      const messageId = state.textBlocks.get(index);
      if (messageId) {
        output.push({ type: "TEXT_MESSAGE_END", messageId });
        state.textBlocks.delete(index);
      }
      const toolCallId = state.toolBlocks.get(index);
      if (toolCallId) {
        output.push({ type: "TOOL_CALL_END", toolCallId });
        state.toolBlocks.delete(index);
      }
    }
    return output;
  }

  if (message.type === "user" && Array.isArray(message.message?.content)) {
    for (const block of message.message.content) {
      if (block.type === "tool_result") {
        output.push({
          type: "TOOL_CALL_RESULT",
          messageId: message.uuid,
          toolCallId: block.tool_use_id,
          content: typeof block.content === "string" ? block.content : JSON.stringify(block.content),
          role: "tool",
        });
      }
    }
  }

  if (message.type === "result" && message.session_id) {
    output.push({ type: "CUSTOM", name: "mentor_session", value: { sessionId: message.session_id } });
  }
  return output;
}
