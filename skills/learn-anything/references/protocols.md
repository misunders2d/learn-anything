# Protocol reference

## AG-UI

Reference server emits AG-UI lifecycle and message event names over SSE. Required run boundary is `RUN_STARTED` followed by `RUN_FINISHED` or `RUN_ERROR`. Text uses `TEXT_MESSAGE_START`, one or more `TEXT_MESSAGE_CONTENT` events, then `TEXT_MESSAGE_END`.

Primary reference: https://docs.ag-ui.com/concepts/events

## A2UI

The work canvas uses an A2UI v0.9 envelope-compatible Learn Anything catalog subset. Each JSON message has `"version": "v0.9"` and exactly one of `createSurface`, `updateComponents`, `updateDataModel`, or `deleteSurface`. Components form a flat adjacency list rooted at id `root`; the trusted browser catalog maps declarative component names to local React implementations. The reducer validates catalog identity, graph references, cycles, depth, reachability, and bounded total state before replacing the last-known-good canvas.

Primary reference: https://github.com/a2ui-project/a2ui

AG-UI transports mentor lifecycle, text, tool, state, and custom A2UI events. Reduced profiles must preserve a dynamic browser canvas, learner actions, execution visibility, persistence, and explicit degradation reporting.
