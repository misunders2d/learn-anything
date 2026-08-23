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

Update stage:

```bash
node <kit-root>/scripts/mentor.mjs stage --url <server-url> --token <access-token> --mentor-id <stable-id> --file <stage.json>
```

Repeat `next` without `--takeover` only while actively supervising learning session. Stop when learner ends session or server disappears. Per-turn delivery is degraded mode; browser must show that status.
