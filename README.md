# learn-anything

`learn-anything` is a constructor kit for local coding agents. It does not ship one universal learning application. It gives an invoking agent known-good blocks for assembling a browser-based, adaptive learning workspace for the current user, topic, harness, and machine.

## Install

```bash
npm install --global @misunders2d/learn-anything
learn-anything probe
```

The npm package includes `SKILL.md` and every constructor asset. Point your local coding agent at the bundled skill, or vendor the package into the skill directory supported by that harness. The CLI remains the same across operating systems and agent harnesses.

## Local development

```bash
npm install
npm run build
node bin/learn-anything.mjs probe
node bin/learn-anything.mjs create "Rust lifetimes" --root /path/to/project
node bin/learn-anything.mjs start --session /path/to/project/.learnings/rust-lifetimes
```

The `start` command prints the base URL, token-bearing launch URL, mentor attachment state, and mentor access token. For Claude and Codex profiles it starts the bundled mentor adapter automatically. Pass `--open` to open the launch URL, `--no-open` for headless verification, or `--no-mentor` for isolated server testing. API routes reject foreign origins and require the per-session token.

## Package contents

- `SKILL.md` — agent-facing detection, construction, launch, and supervision workflow.
- `blocks/` — reusable server, browser, adapter, and execution assets.
- `profiles/` — known-good compositions, including portable shell fallback.
- `scripts/` — deterministic probes, construction helpers, mentor bridge, and smoke checks.
- `references/` — contracts, protocol notes, and teaching guidance loaded only when relevant.

## Current boundary

Implemented core: capability probe, learning-directory materialization, assembly manifest, Node server, adaptive browser stage, persistent transcript/stage state, safe language runners, AG-UI-shaped events, opaque A2UI carriage, Claude and Codex headless adapters, and shell long-poll mentor bridge.

Not part of the first core: container image blocks, local voice binaries, spreadsheet/attention/system-design components, or a universal native adapter for every harness. This version therefore records `host-execution` in every assembly manifest even when Docker or Podman is installed; an invoking agent may supply a compatible container block as environment-specific glue.
