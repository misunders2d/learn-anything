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
3. Choose the smallest compatible persistent profile:
   - Read `profiles/pi-cli.json` when Pi is the active harness. It uses Pi headless mode as a persistent browser mentor; never substitute the manual shell bridge.
   - Read `profiles/reference.json` only when the Claude Agent SDK is the active authenticated adapter.
   - Read `profiles/codex-cli.json` whenever the installed Codex CLI is the available persistent adapter.
   - Use `profiles/portable-shell.json` only for explicit manual/degraded operation. It cannot wake a terminal agent from the browser and must never be presented as live mentorship.
4. Choose learning root:
   - Current project goal: `<project-root>/.learnings/<topic-slug>/`.
   - General topic: `~/learnings/<topic-slug>/`.
5. Choose execution infrastructure for the current activity and machine:
   - Prefer an existing harness sandbox, browser-native execution, or installed language toolchain that satisfies the lesson.
   - Install missing lightweight dependencies in the project or user scope when that is the least invasive suitable option.
   - Use `--execution container` only when process isolation is materially needed and Docker or Podman is already available or the learner explicitly approves its system installation.
   - Default to `--execution host` for trusted learner code. Fixed commands prevent browser-supplied shell injection, but learner programs retain the current user's local permissions; disclose that when runnable code appears.
   - Never treat missing Docker or Podman as a failure or degradation by itself. Ask before privileged or system-wide installation.
6. Construct or resume:

   ```bash
   node <kit-root>/bin/learn-anything.mjs create "<topic>" --root "<project-root>" --profile <profile-id> --execution <host|container> --json
   ```

7. Review returned capability warnings. Never hide the permissions of the selected execution mode or non-streaming degradation.
8. Launch server in a supervised background process:

   ```bash
   node <kit-root>/bin/learn-anything.mjs start --session "<session-dir>" --open
   ```

9. Capture `url`, `launchUrl`, and `accessToken` from start output. Open only `launchUrl`. Verify `/healthz` before telling learner workspace is ready. Never expose the token to remote pages or lesson content.
   If the package reports an incompatible saved manifest or the user deliberately changes adapters or execution modes, rerun `create` with `--migrate`. Never edit `session.json` manually; migration writes a backup and preserves learner state.
10. `start` resolves the composition's mentor adapter through the agent-agnostic block contract, waits for its provider-qualified readiness signal, and supervises restart/interrupt behavior. Require `mentorAttached: true`; normal launch fails instead of opening an unstaffed workspace. `--no-mentor` is explicit manual/test mode only.
11. Keep browser interaction primary after launch. Persist milestone notes and update the A2UI canvas when the lesson needs a different interaction.

## Composition rules

- Reuse complete blocks. Configure them; do not regenerate server or browser code from scratch.
- Compose for the current learning activity as well as the host. Choose subject-native primitives and runners from the catalog; do not force every activity through a generic code/terminal surface.
- Write minimal glue only when no supplied adapter matches current harness.
- Scope writable paths to learning directory. Treat project source as read-only unless learner explicitly authorizes project edits.
- Select execution by lesson need and verified machine capability; no backend is universally preferred. Docker and Podman are optional containment blocks, not prerequisites.
- Provision the least invasive suitable infrastructure. Prefer project-local or user-scope dependencies; require explicit learner approval before privileged or system-wide installation.
- Save selected block versions, capability evidence, execution mode, and degradation decisions in `session.json`; revalidate before launch when capabilities change.
- If browser opener is absent, print URL instead of failing construction.
- If required Node runtime is absent, stop and state exact installation or alternative-block need.

## Teaching behavior

Read `references/pedagogy.md` before mentoring. For repository or large build goals, inspect only relevant source and turn end goal into working milestones. Teach concepts just before learner needs them. Use progressive hints; do not seize keyboard and complete exercise unless learner asks.

Begin with the artifact the learner wants to create, expressed in their language and shown as one concrete request-to-output flow. Delay profiles, adapters, transports, and sandbox choices until the learner understands the artifact boundary. A learner asking what the current task means is a signal to return to chat and replace the task with a clearer prerequisite.

Assume no prior knowledge until conversation demonstrates otherwise. Infer level continuously; do not ask the learner to self-label and do not use an opening quiz or coding test. Before presenting code, teach the needed idea, show a worked example when useful, state one clear change, and make the expected result visible. Increase compression and task difficulty only as the learner demonstrates readiness.

Keep implementation scaffolding backstage. The learner sees and edits the subject's own artifact: SQL for SQL, a passage for literature, a diagram or parameters for a visual model, and source code for the language being learned. Database seeding, test fixtures, wrapper programs, compiler arguments, and transport glue belong in prefab runner blocks. Reveal them only when they are the learning objective or the learner asks. If no subject-native runner exists, use a non-runnable native artifact instead of wrapping it in another language.

Treat browser events as observation, not paperwork. The mentor already receives submitted code, execution output, errors, and interactive answers; react to that evidence automatically. Unsent drafts persist but do not wake the mentor. Do not ask the learner to repeat captured evidence or tick a box confirming it. Use checklists only for external actions the workspace cannot observe.

## Dynamic A2UI canvas

The agent creates and updates the work canvas with actual A2UI v0.9 messages. In shell/manual mode use `node <kit-root>/scripts/mentor.mjs canvas --url <server-url> --token <access-token> --mentor-id <stable-id> --file <payload.json>`. The payload is `{ "focus": "chat|work", "messages": [...] }`; each message is one `createSurface`, `updateComponents`, `updateDataModel`, or `deleteSurface` envelope with `"version": "v0.9"`. Read `references/stage-catalog.md` for the learning component catalog.

Drive the whole browser flow with `focus`: use `chat` for broad discussion and debriefing; use `work` when the learner has one clear interactive task. Every work surface keeps the browser-owned compact question composer visible. Text/code selection or **Ask about this** supplies a component anchor and optional excerpt. Answer that clarification beside the targeted component without replacing or leaving the work surface. Anchor execution feedback to its code component when useful. Do not create split views or ask the learner to manage layout. The browser-owned **Ask mentor** rescue control must remain available outside agent-rendered content; preserve active work underneath it.

Prefer artifact, action, and feedback in one local surface. Structured results belong beside the artifact that produced them; do not add a global terminal console when a table, targeted diagnostic, annotation, or figure expresses the result more clearly.

## Resume

Use the existing session directory. Do not replace transcript, exercises, A2UI canvas, or assembly manifest. Start repaints saved browser state before the persistent mentor reconnects.

## Validation

Before reporting ready:

```bash
node <kit-root>/bin/learn-anything.mjs smoke --session "<session-dir>"
```

Then verify the real selected composition in a browser. Type a learner message and click **Send**; observe waiting/responding status and an actual mentor reply without returning to the terminal. Continue until the mentor creates an A2UI work canvas, ask one question through its compact composer, press Tab in the code editor and confirm it indents without moving focus, run code when present, click **Ask mentor**, and verify chat returns without blanking or losing work. Press Enter and Shift+Enter in the composer, refresh once, and stop the launcher to confirm the workspace server exits. Do not report ready from API calls, DOM injection, unit tests, or visual inspection alone.

Also open one stale or invalid session token. It must show explicit recovery guidance within the browser rather than remaining indefinitely on “Connecting” or “Reconnecting.”

Success requires health response, browser assets, real Send-to-mentor round trip, visible dynamic focus changes, working current controls, persistence across refresh, one available execution runner, and a working rescue path.
