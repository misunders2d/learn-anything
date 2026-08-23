# Dynamic stage catalog

Post versioned JSON:

```json
{
  "version": "learn-anything/v1",
  "surfaceId": "lesson",
  "focus": "chat",
  "title": "Ownership checkpoint",
  "components": []
}
```

`focus` controls the whole browser workspace:

- `chat`: conversation is the primary activity for explanation, questions, alignment, or debrief.
- `work`: the interactive stage is the primary activity for coding, diagrams, quizzes, checklists, or another concrete task.

Set `focus` on every stage update. The mentor owns transitions; never offer split view or learner-managed layout controls. If `focus` is missing, the browser falls back to `work` for runnable or interactive components and `chat` for explanatory content.

The browser shell, not the stage payload, owns a compact question composer visible on every `work` surface. Agents must not recreate, hide, or replace it. Text/code selection or **Ask about this** adds `{componentId, label, quote?}` context to the learner message. A work clarification keeps the current surface mounted; its mentor reply carries the same or agent-selected component context and renders as an anchored note beside that component. **Ask mentor** remains the separate full-conversation rescue path.

Supported component types:

- `markdown`: `{ "type": "markdown", "content": "..." }`
- `callout`: `{ "type": "callout", "tone": "info|success|warning", "title": "...", "content": "..." }`
- `code`: `{ "type": "code", "language": "sql|javascript|python|rust|c|any display syntax", "value": "learner-facing artifact only", "runnable": true, "run": { "runner": "sqlite|javascript|python|rust|c", "setup": "optional hidden fixture" } }`
- `table`: `{ "type": "table", "caption": "books", "columns": ["title", "author"], "rows": [["Kindred", "Octavia Butler"]] }`
- `passage`: `{ "type": "passage", "text": "...", "source": "...", "annotations": [{ "quote": "...", "note": "..." }] }`
- `figure`: `{ "type": "figure", "mermaid": "flowchart LR ...", "caption": "...", "callouts": [{ "label": "..." }] }`
- `params`: `{ "type": "params", "title": "...", "controls": [{ "id": "phase", "label": "Phase", "min": 0, "max": 6.28, "step": 0.01, "value": 0 }] }`
- `mermaid`: `{ "type": "mermaid", "source": "flowchart LR ..." }`
- `quiz`: `{ "type": "quiz", "question": "...", "options": [{ "id": "a", "label": "..." }] }`
- `checklist`: `{ "type": "checklist", "items": [{ "id": "x", "label": "...", "done": false }] }`

Unknown components render as inspectable JSON instead of breaking surface. This catalog can wrap or map A2UI payloads while protocol evolves.

`language` is presentation, not execution. `run.runner` selects a known prefab backend. `run.setup` never renders in the learner's editor. If `run` is absent, the artifact remains editable but non-runnable. Keep setup code and host-language wrappers out of `value`.
