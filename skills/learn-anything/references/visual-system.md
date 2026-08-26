# Visual system

The prefab browser is a learning canvas, not an admin dashboard. Keep shell stable across topics; let subject-native artifacts provide variation.

## Core rule

The subject artifact is the page. Use a bordered container only for one discrete actionable object, normally a runnable editor. Do not nest repeated cards or give every component the same box treatment.

Every screen needs one clear focal artifact and one visible next action. Supporting explanation, feedback, and controls stay adjacent to what they explain. Do not make learners hunt across panes or scroll backward to discover what changed.

## Semantic tokens

Treat the existing CSS variables as the canonical system for canvas, surface, text, muted text, rule, accent, positive, attention, danger, plot series, measure, and gutter. Extend semantic roles instead of scattering literal colors, spacing, radii, shadows, or durations through components.

The values below belong to this product, not a universal design recipe. Preserve them unless a deliberate redesign changes the whole system and verifies every state.

## Type and measure

- Explanation and passages: Georgia / Iowan-style serif, about 19px with generous line height, maximum 68 characters per line.
- Interface controls: Inter or the local system sans, 13–15px.
- Code, SQL, and numeric output: JetBrains Mono or the local system monospace, 13–14px with tabular numerals.
- Use only regular and semibold weights. Let scale and spacing establish hierarchy.
- Let long titles and translated labels wrap or truncate with an accessible full value; never let them hide the primary action.

## Color

Default to warm paper (`#fbfaf7`) with near-black ink (`#1b1a18`), white and warm-grey secondary surfaces, hairline rules, and one cobalt accent (`#315ddc`). Success, warning, and error each have one semantic color and soft background. Never build a lesson from a stack of interchangeable blue-grey slabs.

Check rendered foreground/background pairs, focus indicators, disabled controls, charts, and status states against WCAG 2.2 AA. Token names are not proof of contrast.

## Shell states

- Empty chat: center topic, orientation, and first composer. Hide empty-stage placeholders.
- Active chat: one narrow reading stream. Mentor prose is unboxed; learner turns use one quiet contrasting surface.
- Work: one centered artifact column. Put feedback directly below its cause. Keep the contextual question input subordinate but always usable.
- Waiting/responding: preserve current artifact and show a nearby live status without shifting the page.
- Offline/stale/stopped: explain what happened, what remains saved, and the exact recovery action. Never loop on an indefinite connection label.
- Failed component: contain failure locally and preserve the rest of the activity and rescue path.

The mentor controls chat/work focus. The learner never manages layout. Both regions stay mounted so state survives transitions.

## Components

- Markdown: type only.
- Callout: semantic left rule and soft tint, no card.
- Code/query: dark monospace artifact with **Run** for unrestricted experimentation and a separate, secondary **Submit to mentor** action for feedback; size to content within viewport bounds.
- Table: aligned columns and one header rule; avoid boxed cells and zebra-striping.
- Passage: editorial serif with annotations as marginalia or inline notes.
- Figure: centered visual with a quiet caption.
- Math: native MathML with generous spacing and a plain-language caption; never use raw agent HTML.
- Plot: clean local SVG, labeled axes, distinguishable line patterns, a concise legend, and an expandable data table for accessibility.
- Parameters: aligned label, live monospace value, and a clear control placed next to the artifact it changes.
- Quiz/checklist: accessible rows separated by hairlines, not stacks of boxes.

## Content resilience

Every supplied or generated surface must tolerate:

- narrow and wide viewports;
- 200% browser zoom and text enlargement;
- long headings, labels, URLs, code lines, numbers, and error messages;
- zero, one, and many rows or items;
- loading, empty, partial, error, success, disabled, and read-only states when applicable;
- translated content and right-to-left direction using logical layout properties;
- touch, pointer, and keyboard input.

Reflow before shrinking. Horizontal scrolling is acceptable only inside artifacts that genuinely require it, such as code, wide data, diagrams, or math. Keep navigation, primary actions, rescue controls, and feedback visible outside those scroll regions.

## Accessibility floor

- Meet WCAG 2.2 AA for the web shell and rendered learning components.
- Use semantic controls and landmarks, meaningful names, associated labels and errors, visible focus, and logical focus order.
- Restore or move focus intentionally after focus changes, dialogs, failures, and inserted feedback.
- Announce waiting, execution, error, and completion changes without relying on color or motion alone.
- Keep plots and visual models paired with labels, captions, assumptions, and accessible data or text alternatives.
- Preserve editor keyboard behavior without trapping the learner outside documented editing conventions.

## Motion and recovery

Motion must explain focus, state, or feedback. Default shell transitions target 120–200ms opacity, color, or small translation, but exact values may change when rendered behavior requires it. Keep transitions interruptible and never delay an action or hide final content.

Disable nonessential motion for reduced-motion users. Reduced-motion mode must render the same stable final state. Pause continuous work when offscreen and clean up listeners, observers, animation frames, timers, media, and rendering resources.

A stale token must explain that the tab belongs to an earlier workspace; a stopped server must say saved work is local and how to restart it. Never leave the learner on an endless “reconnecting” screen.

## Design QA

Before declaring a workspace ready, verify the real rendered composition—not only source or API responses:

1. At 1280×800, confirm the first required action and its instruction fit together without hunting.
2. At a narrow mobile viewport, exercise chat, work, rescue, editor, and current controls without page-level horizontal overflow.
3. At 200% zoom or equivalent text enlargement, confirm content reflows and primary actions, feedback, and recovery remain available.
4. Navigate by keyboard; inspect visible focus, order, editor Tab behavior, activation, and focus restoration.
5. Enable reduced motion; confirm transitions settle immediately into complete visible states.
6. Stress long/localized/right-to-left content plus loading, empty, error, disabled, and success states relevant to the active surface.
7. Measure contrast on rendered normal, focus, disabled, semantic, and chart states against WCAG 2.2 AA.
8. Record what was visually inspected, mechanically checked, inferred, and not tested.
