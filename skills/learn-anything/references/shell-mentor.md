# Shell mentor bridge

Use this when harness has shell tools but no supported persistent streaming adapter.

```bash
node <kit-root>/scripts/mentor.mjs next --url <server-url> --token <access-token> --mentor-id <stable-id> --takeover
```

Use one random, stable mentor id for the process lifetime. `--takeover` belongs only on first poll; it replaces any stale supervisor lease.

Command waits for next learner message. After reasoning, send mentor text:

```bash
node <kit-root>/scripts/mentor.mjs text --url <server-url> --token <access-token> --mentor-id <stable-id> --file <response.txt>
```

Update browser canvas:

```bash
node <kit-root>/scripts/mentor.mjs canvas --url <server-url> --token <access-token> --mentor-id <stable-id> --file <payload.json>
```

`payload.json` uses `{ "focus": "chat|work", "messages": [...], "continuation": { "kind": "question|action", "text": "...", "taskTitle": "required for work", "targetComponentId": "required for work", "actionType": "run|edit|answer|adjust|read|inspect|submit" } }`. Chat requires a direct question. Work requires a concrete action, localized task title, target component that exists on the active surface after messages apply, and actionType compatible with both the action verb and target component.

Repeat `next` without `--takeover` only while actively supervising learning session. Stop when learner ends session or server disappears. Per-turn delivery is degraded mode; browser must show that status.
