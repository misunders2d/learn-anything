# Shell mentor bridge

Use this only for explicitly selected manual operation when a harness has shell tools but no supported persistent adapter. The bridge does not wake an idle terminal agent.

```bash
node <kit-root>/scripts/mentor.mjs next --url <server-url> --token <access-token> --mentor-id <stable-id> --takeover
```

Use one random, stable mentor id for the process lifetime. `--takeover` belongs only on first poll; it replaces any stale supervisor lease.

The command waits for the next learner event. Preserve its `mentorTurn.id` and `mentorTurn.baseRevision`. After reasoning, commit the answer and canvas together:

```bash
node <kit-root>/scripts/mentor.mjs turn --url <server-url> --token <access-token> --mentor-id <stable-id> --file <turn.json>
```

`turn.json` includes `turnId`, `baseRevision`, learner-facing `message`, and the canvas payload below. Use `messages: []` to preserve the existing canvas. Optional `milestone` and `pattern` follow `mentor-recovery.md` and `teaching-patterns.md`. Only a successful atomic commit completes delivered work; legacy streamed text or a canvas update alone does not acknowledge the queue item. A revision conflict retains the question for browser retry; never silently replace its revision.

The standalone compatibility command can update the browser canvas when no complete response is being published:

```bash
node <kit-root>/scripts/mentor.mjs canvas --url <server-url> --token <access-token> --mentor-id <stable-id> --file <payload.json>
```

`payload.json` uses `{ "focus": "chat|work", "messages": [...], "continuation": { "kind": "question|action", "text": "...", "taskTitle": "required for work", "targetComponentId": "required for work", "actionType": "run|edit|answer|adjust|read|inspect|submit" } }`. Chat requires a direct question. Work requires a concrete action, localized task title, target component that exists on the active surface after messages apply, and actionType compatible with both the action verb and target component.

Repeat `next` without `--takeover` only while actively supervising learning session. Stop when learner ends session or server disappears. Per-turn delivery is degraded mode; browser must show that status.
