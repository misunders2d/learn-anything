# Roadmap

Candidates for review. Nothing here is decided. Each item names the problem, what the
spec says, and the options. The spec (`SPEC.md`, `skills/learn-anything/SKILL.md`,
`skills/learn-anything/references/`) wins over anything listed here.

## Renderer fixes to restore

These were built and tested in September 2026 but were lost when the rejected pane-layout
work was deleted.

1. **Focus goes to the named target.** `focusWorkSurface()` focuses the first element that
   matches a hardcoded selector list, not the continuation's `targetComponentId`. Any new
   component type is silently missed. Spec: pin the instruction before the target and
   visually mark that one target (`pedagogy.md`).
2. **Quiz and Checklist save errors.** Clicks call the API without handling errors, so a
   failed save does nothing visible. Spec: contain failure locally and announce errors
   (`visual-system.md`).

## Spec-compatible additions

3. **Kit-shipped input primitives.** Learners can answer only through buttons, checkboxes,
   sliders, code, or the composer. Candidates: TextInput, NumericInput with units,
   MultiSelect, RegionSelect on Passage/Figure, consent-gated AudioRecord. Spec: new
   surfaces are prefab blocks with a renderer, schema, and accessibility and interaction
   tests (`SPEC.md` §3.2, `teaching-patterns.md`). Decide which, if any.
4. **Quiz scored locally.** Every answer round-trips to the mentor. Option: when the mentor
   supplies an answer key, score and explain immediately in the browser and still send the
   answer as an observation.
5. **`createSurface.theme` is stored but never rendered.** Options: remove the field, or
   support a small set of named palettes with contrast checked in light and dark.

## Known spec limitations to confirm or amend

6. **Literal `{"path": ...}` data is read as a binding.** A lesson cannot show an object
   whose only key is `path` (for example a file-system example). The spec defines that exact
   binding object (`stage-catalog.md`). Keep it as a documented limit, or amend the spec.
7. **Removing a component means recreating the surface.** A2UI is limited to four message
   types (`protocols.md`), so deleting one component resets the surface's data model,
   drafts, and run results. Keep it, or amend the spec.

## Hardening

8. **Mermaid SVG is inserted without DOMPurify.** Mermaid's strict mode covers most of it;
   sanitizing the rendered SVG would be defense in depth.
9. **Plot points are clickable but hidden from assistive technology.** The spec's
   accessible path is the component-level question (`stage-catalog.md`). Keep the per-point
   click as a mouse shortcut, or remove it.
10. **Test for the Pi re-prompt fix.** Pi no longer re-prompts after a host rejection it
    cannot correct, but no test pins that behavior yet.
11. **Codex chat turns under strict output mode.** Confirm with one live codex turn that a
    chat turn can still send an empty `action_type` when `--output-schema` is strict.
