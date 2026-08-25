# Visual system

The prefab browser is a learning canvas, not an admin dashboard.

## Core rule

The subject artifact is the page. Use a bordered container only for one discrete actionable object, normally a runnable editor. Do not nest repeated cards or give every component the same box treatment.

## Type and measure

- Explanation and passages: Georgia / Iowan-style serif, about 19px with generous line height, maximum 68 characters per line.
- Interface controls: Inter or the local system sans, 13–15px.
- Code, SQL, and numeric output: JetBrains Mono or the local system monospace, 13–14px with tabular numerals.
- Use only regular and semibold weights. Let scale and spacing establish hierarchy.

## Color

Default to warm paper (`#fbfaf7`) with near-black ink (`#1b1a18`), white and warm-grey secondary surfaces, hairline rules, and one cobalt accent (`#315ddc`). Success, warning, and error each have one semantic color and soft background. Never build a lesson from a stack of interchangeable blue-grey slabs.

## Shell states

- Empty chat: center topic, orientation, and first composer. Hide empty-stage placeholders.
- Active chat: one narrow reading stream. Mentor prose is unboxed; learner turns use one quiet contrasting surface.
- Work: one centered artifact column. Put feedback directly below its cause. Keep the contextual question input subordinate but always usable.

The mentor controls chat/work focus. The learner never manages layout. Both regions stay mounted so state survives transitions.

## Components

- Markdown: type only.
- Callout: semantic left rule and soft tint, no card.
- Code/query: dark monospace artifact with one Run action; size to content within viewport bounds.
- Table: aligned columns and one header rule; avoid boxed cells and zebra-striping.
- Passage: editorial serif with annotations as marginalia or inline notes.
- Figure: centered visual with a quiet caption.
- Math: native MathML with generous spacing and a plain-language caption; never use raw agent HTML.
- Plot: clean local SVG, labeled axes, distinguishable line patterns, a concise legend, and an expandable data table for accessibility.
- Parameters: aligned label, live monospace value, and a clear control placed next to the artifact it changes.
- Quiz/checklist: accessible rows separated by hairlines, not stacks of boxes.

## Motion and recovery

Use 120–200ms opacity, color, and small translation transitions only. Disable them for reduced-motion users. A stale token must explain that the tab belongs to an earlier workspace; a stopped server must say saved work is local and how to restart. Never leave the learner on an endless “reconnecting” screen.
