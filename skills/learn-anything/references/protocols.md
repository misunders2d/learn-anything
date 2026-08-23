# Protocol reference

## AG-UI

Reference server emits AG-UI lifecycle and message event names over SSE. Required run boundary is `RUN_STARTED` followed by `RUN_FINISHED` or `RUN_ERROR`. Text uses `TEXT_MESSAGE_START`, one or more `TEXT_MESSAGE_CONTENT` events, then `TEXT_MESSAGE_END`.

Primary reference: https://docs.ag-ui.com/concepts/events

## A2UI

A2UI is currently evolving. Treat stage payload as opaque versioned JSON at transport boundary. Renderer supports kit catalog plus raw-payload fallback. Do not make construction depend on one preview message shape.

Primary reference: https://github.com/google/A2UI

AG-UI and A2UI are preferred, not mandatory. Any alternative must preserve dynamic browser stage, learner actions, execution visibility, persistence, and explicit degradation reporting.
