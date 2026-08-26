# A2UI learning canvas catalog

Post a flow focus plus A2UI v0.9 messages:

```json
{
  "focus": "work",
  "continuation": { "kind": "action", "text": "Change quantity to 3, then run the code." },
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
        "value": { "title": "Ownership checkpoint", "direction": "ltr" }
      }
    }
  ]
}
```

`continuation` is required on every canvas update. Use `{ "kind": "question", "text": "...?" }` with chat and `{ "kind": "action", "text": "..." }` with work. The browser renders it as the explicit **Your turn** or **Next step** cue.

`focus` controls the browser flow: `chat` shows the conversation; `work` shows the active A2UI surface. The mentor owns transitions. Automatic activity feedback stays in `work`; `chat` is for an explicit broad question or one direct question that requires the learner's answer. The browser-owned compact question composer and **Ask mentor** rescue control remain outside agent-rendered content. Whenever chat hides an existing surface, the same control becomes **Back to activity**. Rescue stays in chat while the learner asks; after the mentor reply completes, its `focus` applies even for the same `surfaceId`, so `work` returns to the preserved activity instead of hiding the control the mentor just referenced.

Set surface data-model `direction` to `ltr`, `rtl`, or `auto`; invalid values fail validation. Use `rtl` when primary learner-facing content reads right-to-left. Browser renderer applies it to active work surface while code/editor artifacts stay left-to-right.

Every surface uses a flat adjacency list. The root component has id `root`; `Column` and `Row` reference child ids. Sending an existing component id updates it. Learner-facing display properties—including nested Plot axes and series, Math expressions, Table data, and Figure content—can reference `updateDataModel` state with the exact binding object `{ "path": "/field" }`. Component ids/types, layout children, execution configuration, and `Params` control definitions are literal; frames update the data model that display properties bind to.

Learning catalog components:

- `Markdown`: `{ "id": "copy", "component": "Markdown", "content": "..." }`
- `Callout`: `{ "id": "hint", "component": "Callout", "tone": "info|success|warning", "title": "...", "content": "..." }`
- `Code`: `{ "id": "editor", "component": "Code", "language": "python", "value": "...", "runnable": true, "run": { "runner": "python", "setup": "optional hidden fixture" } }`
- `Table`: `{ "id": "rows", "component": "Table", "caption": "...", "columns": ["..."], "rows": [["..."]] }`
- `Passage`: `{ "id": "passage", "component": "Passage", "text": "...", "source": "...", "annotations": [{ "quote": "...", "note": "..." }] }`
- `Figure`: `{ "id": "figure", "component": "Figure", "mermaid": "flowchart LR ...", "caption": "...", "callouts": [{ "label": "..." }] }`
- `Math`: `{ "id": "equation", "component": "Math", "expression": "P(x)=\\lvert\\psi(x)\\rvert^2", "display": true, "caption": "..." }`
- `Plot`: `{ "id": "plot", "component": "Plot", "title": "...", "description": "...", "x": { "label": "Position", "unit": "m" }, "y": { "label": "Probability" }, "series": [{ "id": "p", "label": "P(x)", "points": [[0, 0], [1, 0.5]] }], "caption": "..." }`
- `Params`: `{ "id": "params", "component": "Params", "title": "...", "controls": [{ "id": "phase", "label": "Phase", "min": 0, "max": 1, "step": 0.25, "value": 0, "path": "/phase", "frames": [{ "value": 0, "updates": [{ "path": "/plot", "value": [{ "id": "p", "label": "P(x)", "points": [[0, 0], [1, 1]] }] }] }] }] }`
- `Mermaid`: `{ "id": "diagram", "component": "Mermaid", "source": "flowchart LR ..." }`
- `Quiz`: `{ "id": "quiz", "component": "Quiz", "question": "...", "options": [{ "id": "a", "label": "..." }] }`
- `Checklist`: `{ "id": "list", "component": "Checklist", "items": [{ "id": "x", "label": "...", "done": false }] }`

Unknown components render as inspectable JSON instead of crashing the surface. `language` controls presentation; `run.runner` selects a fixed backend. Hidden setup and wrapper code never appear in the learner artifact. Learners may run code repeatedly without creating mentor turns; **Submit to mentor** explicitly sends the current code and latest result for feedback.

`Plot` accepts numeric data only: at most 8 series, 500 points per series, and 2,000 total points. Optional axis bounds must be finite with `min < max`; titles, labels, descriptions, and captions are bounded strings. The browser draws trusted local SVG, exposes one component-level question path rather than a tab stop per point, includes labels and a tabular fallback, and never executes agent-provided drawing code. A plot illustrates a model or relationship; it is not proof by itself.

`Params.frames` are finite, precomputed states—not formulas or JavaScript. While the learner moves a control, the browser applies the nearest frame's declared `updateDataModel` values immediately, so bound `Plot`, `Math`, `Table`, or `Figure` properties change without a mentor round trip. Releasing the control persists the resulting canvas without waking the mentor. Use at most 12 controls, 101 frames per control, and 12 updates per frame. Use frames when the meaningful states are bounded; do not fake continuous simulation with a sparse set of frames.
