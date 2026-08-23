---
name: learn-anything
description: >
  Construct and run an adaptive browser learning workspace when a user asks to learn, study,
  practice, understand, or build something while learning it. Use for topics, programming
  languages, repositories, technical concepts, tools, and goal-driven projects such as
  rewriting an application in an unfamiliar language. The skill detects the local harness and
  machine, composes prefab blocks, launches the workspace, and mentors through the browser.
---

# Learn Anything

Build a learning workspace from this kit. Do not treat the kit itself as one finished universal app.

## Required outcome

Give the learner a usable dynamic browser interface that adapts to the course, lesson flow, exercises, execution results, and progress. Prefer A2UI over AG-UI when compatible. Use another bridge or renderer when needed, but preserve the browser outcome and disclose reduced capabilities.

Use the bundled browser shell as a visual system, not as a generic dashboard template. It is light-first, measure-constrained, and artifact-led: editorial reading type for explanation, monospace for code and data, one accent action per screen, and minimal container chrome. Read `references/visual-system.md` before extending or replacing a surface. Do not regress to blue-grey card grids, split panes, raw terminal styling, or browser-default controls.

## Construction workflow

1. Determine kit root from this `SKILL.md` location.
2. Run `node <kit-root>/bin/learn-anything.mjs probe --json`.
3. Choose smallest compatible profile:
   - Read `profiles/reference.json` when a headless streaming mentor adapter is available.
   - Read `profiles/codex-cli.json` when running under Codex and the `codex` CLI is installed.
   - Read `profiles/portable-shell.json` for any harness with shell tools.
4. Choose learning root:
   - Current project goal: `<project-root>/.learnings/<topic-slug>/`.
   - General topic: `~/learnings/<topic-slug>/`.
5. Construct or resume:

   ```bash
   node <kit-root>/bin/learn-anything.mjs create "<topic>" --root "<project-root>" --profile <profile-id> --json
   ```

6. Review returned capability warnings. Never hide host-execution or non-streaming degradation.
7. Launch server in a supervised background process:

   ```bash
   node <kit-root>/bin/learn-anything.mjs start --session "<session-dir>" --open
   ```

8. Capture `url`, `launchUrl`, and `accessToken` from start output. Open only `launchUrl`. Verify `/healthz` before telling learner workspace is ready. Never expose the token to remote pages or lesson content.
9. `start` automatically attaches the bundled Claude or Codex mentor for those profiles. Require `mentorAttached: true`. For the shell fallback, read `references/shell-mentor.md` and long-poll from the current agent turn.
10. Keep browser interaction primary after launch. Persist milestone notes and update stage when lesson needs a different interaction.

## Composition rules

- Reuse complete blocks. Configure them; do not regenerate server or browser code from scratch.
- Compose for the current learning activity as well as the host. Choose subject-native primitives and runners from the catalog; do not force every activity through a generic code/terminal surface.
- Write minimal glue only when no supplied adapter matches current harness.
- Scope writable paths to learning directory. Treat project source as read-only unless learner explicitly authorizes project edits.
- Prefer container execution. If unavailable, require disclosed host fallback and fixed language runners; never accept arbitrary browser-provided shell commands.
- Save chosen blocks and degradation decisions in `session.json` assembly manifest.
- Run selected block smoke checks before launch.
- If browser opener is absent, print URL instead of failing construction.
- If required Node runtime is absent, stop and state exact installation or alternative-block need.

## Teaching behavior

Read `references/pedagogy.md` before mentoring. For repository or large build goals, inspect only relevant source and turn end goal into working milestones. Teach concepts just before learner needs them. Use progressive hints; do not seize keyboard and complete exercise unless learner asks.

Begin with the artifact the learner wants to create, expressed in their language and shown as one concrete request-to-output flow. Delay profiles, adapters, transports, and sandbox choices until the learner understands the artifact boundary. A learner asking what the current task means is a signal to return to chat and replace the task with a clearer prerequisite.

Assume no prior knowledge until conversation demonstrates otherwise. Infer level continuously; do not ask the learner to self-label and do not use an opening quiz or coding test. Before presenting code, teach the needed idea, show a worked example when useful, state one clear change, and make the expected result visible. Increase compression and task difficulty only as the learner demonstrates readiness.

Keep implementation scaffolding backstage. The learner sees and edits the subject's own artifact: SQL for SQL, a passage for literature, a diagram or parameters for a visual model, and source code for the language being learned. Database seeding, test fixtures, wrapper programs, compiler arguments, and transport glue belong in prefab runner blocks. Reveal them only when they are the learning objective or the learner asks. If no subject-native runner exists, use a non-runnable native artifact instead of wrapping it in another language.

Treat browser events as observation, not paperwork. The mentor already receives submitted code, execution output, errors, and interactive answers; react to that evidence automatically. Unsent drafts persist but do not wake the mentor. Do not ask the learner to repeat captured evidence or tick a box confirming it. Use checklists only for external actions the workspace cannot observe.

## Dynamic stage

Use `node <kit-root>/scripts/mentor.mjs stage --url <server-url> --token <access-token> --mentor-id <stable-id> --file <payload.json>` to update stage in shell mode. Read `references/stage-catalog.md` for supported components. Prefer smallest surface that helps current lesson.

Drive the whole browser flow with the stage envelope's `focus`: use `chat` for broad discussion and debriefing; use `work` when the learner has one clear interactive task. Set `focus` on every stage update. Every work surface keeps the browser-owned compact question composer visible. Text/code selection or **Ask about this** supplies a component anchor and optional excerpt. Answer that clarification beside the targeted component without replacing or leaving the work surface. Anchor execution feedback to its code component when useful. Do not create split views or ask the learner to manage layout. The browser-owned **Ask mentor** rescue control must remain available outside agent-rendered content; preserve active work underneath it.

Prefer artifact, action, and feedback in one local surface. Structured results belong beside the artifact that produced them; do not add a global terminal console when a table, targeted diagnostic, annotation, or figure expresses the result more clearly.

## Resume

Use existing session directory. Do not replace transcript, exercises, stage, or assembly manifest. Start command repaints saved browser state before mentor reconnects.

## Validation

Before reporting ready:

```bash
node <kit-root>/bin/learn-anything.mjs smoke --session "<session-dir>"
```

Then verify the real selected composition in a browser. Type a learner message and click **Send**; observe visible waiting/responding status and an actual mentor reply. Continue until the mentor posts a work surface, ask one question through its compact composer, click its current controls, run code when present, click **Ask mentor**, and verify chat returns without blanking or losing work. Press Enter and Shift+Enter in the composer and refresh once. Do not report ready from API calls, DOM injection, unit tests, or visual inspection alone.

Also open one stale or invalid session token. It must show explicit recovery guidance within the browser rather than remaining indefinitely on “Connecting” or “Reconnecting.”

Success requires health response, browser assets, real Send-to-mentor round trip, visible dynamic focus changes, working current controls, persistence across refresh, one available execution runner, and a working rescue path.
