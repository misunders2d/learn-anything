# A2UI learning canvas catalog

Post a flow focus plus A2UI v0.9 messages:

```json
{
  "focus": "work",
  "messages": [
    {
      "version": "v0.9",
      "createSurface": {
        "surfaceId": "lesson",
        "catalogId": "urn:learn-anything:catalog:v1"
      }
    },
    {
      "version": "v0.9",
      "updateComponents": {
        "surfaceId": "lesson",
        "components": [
          { "id": "root", "component": "Column", "children": ["intro"] },
          { "id": "intro", "component": "Markdown", "content": "One clear explanation" }
        ]
      }
    },
    {
      "version": "v0.9",
      "updateDataModel": {
        "surfaceId": "lesson",
        "path": "/",
        "value": { "title": "Ownership checkpoint" }
      }
    }
  ]
}
```

`focus` controls the browser flow: `chat` shows the conversation; `work` shows the active A2UI surface. The mentor owns transitions. The browser-owned compact question composer and **Ask mentor** rescue control remain outside agent-rendered content.

Every surface uses a flat adjacency list. The root component has id `root`; `Column` and `Row` reference child ids. Sending an existing component id updates it. `updateDataModel` values can be referenced with `{ "path": "/field" }`.

Learning catalog components:

- `Markdown`: `{ "id": "copy", "component": "Markdown", "content": "..." }`
- `Callout`: `{ "id": "hint", "component": "Callout", "tone": "info|success|warning", "title": "...", "content": "..." }`
- `Code`: `{ "id": "editor", "component": "Code", "language": "python", "value": "...", "runnable": true, "run": { "runner": "python", "setup": "optional hidden fixture" } }`
- `Table`: `{ "id": "rows", "component": "Table", "caption": "...", "columns": ["..."], "rows": [["..."]] }`
- `Passage`: `{ "id": "passage", "component": "Passage", "text": "...", "source": "...", "annotations": [{ "quote": "...", "note": "..." }] }`
- `Figure`: `{ "id": "figure", "component": "Figure", "mermaid": "flowchart LR ...", "caption": "...", "callouts": [{ "label": "..." }] }`
- `Params`: `{ "id": "params", "component": "Params", "title": "...", "controls": [{ "id": "phase", "label": "Phase", "min": 0, "max": 6.28, "step": 0.01, "value": 0 }] }`
- `Mermaid`: `{ "id": "diagram", "component": "Mermaid", "source": "flowchart LR ..." }`
- `Quiz`: `{ "id": "quiz", "component": "Quiz", "question": "...", "options": [{ "id": "a", "label": "..." }] }`
- `Checklist`: `{ "id": "list", "component": "Checklist", "items": [{ "id": "x", "label": "...", "done": false }] }`

Unknown components render as inspectable JSON instead of crashing the surface. `language` controls presentation; `run.runner` selects a fixed backend. Hidden setup and wrapper code never appear in the learner artifact.
