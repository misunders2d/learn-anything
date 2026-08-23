# Learn Anything

Learn Anything turns a topic, repository, or build goal into a local browser-based learning workspace. Lessons can mix explanation, chat, code, diagrams, exercises, and runnable examples. Progress stays on your machine, and an interrupted session can be resumed later.

The package is built for coding agents rather than tied to one fixed course or interface. It checks the available tools, chooses a compatible setup, and assembles only the pieces needed for the lesson.

## Install

### Pi

```bash
pi install npm:@misunders2d/learn-anything
```

### Oh My Pi

```bash
omp install @misunders2d/learn-anything
```

Both commands install the npm package and register its `learn-anything` skill. Start a new session after installation if the skill is not visible in the current one.

For direct CLI use:

```bash
npm install --global @misunders2d/learn-anything
learn-anything probe
```

Requires Node.js 20 or newer.

## Update

Pi:

```bash
pi update npm:@misunders2d/learn-anything
```

Oh My Pi:

```bash
omp install @misunders2d/learn-anything@latest
```

Global CLI installation:

```bash
npm install --global @misunders2d/learn-anything@latest
```

## Start a lesson

Ask your agent to teach a topic or help you build something while learning it. For example:

```text
Teach me Rust ownership by building a small command-line program.
```

```text
Help me understand this repository, then guide me through adding a feature.
```

```text
Teach me SQL joins with examples I can run in the browser.
```

The agent creates a workspace under `.learnings/` for project work or `~/learnings/` for a general topic. It launches the browser, keeps lesson state on disk, and resumes the same workspace when you return.

## Command line

Check available runtimes and adapters:

```bash
learn-anything probe
```

Create a workspace:

```bash
learn-anything create "Rust lifetimes" --root /path/to/project
```

Start it:

```bash
learn-anything start --session /path/to/project/.learnings/rust-lifetimes --open
```

Run the built-in smoke check:

```bash
learn-anything smoke --session /path/to/project/.learnings/rust-lifetimes
```

`start` prints a local URL and a token-bearing launch URL. Open only the launch URL. Use `--no-open` on headless systems and `--no-mentor` when testing the server by itself.

## What is included

The package ships one complete skill under `skills/learn-anything/`:

- `SKILL.md` — lesson construction and mentoring workflow
- `blocks/` — browser, server, adapter, and execution building blocks
- `profiles/` — tested compositions for supported environments
- `references/` — teaching, protocol, component, and visual guidance
- `scripts/` — capability checks, workspace construction, mentor bridge, and verification
- `bin/` — command-line entry point

Pi reads the package through its `pi.skills` manifest. Oh My Pi discovers the same conventional `skills/` directory.

## Safety and privacy

Learning sessions are local. The browser server accepts requests only from its own origin and protects session routes with a per-session token. Host execution is clearly recorded in each workspace manifest. Browser-provided text is never passed through as an arbitrary shell command; runners use fixed language commands and keep writable files inside the learning directory.

Review package source before installation. Pi and Oh My Pi packages run with the same local access as the agent that loads them.

## Current limits

The package includes Claude, Codex, and portable shell profiles. Container image blocks, local voice runtimes, and a native adapter for every agent harness are not included yet. When no native mentor adapter is available, the portable shell profile keeps the browser workflow working with reduced streaming support.

## Development

```bash
git clone https://github.com/misunders2d/learn-anything.git
cd learn-anything
npm install
npm run build
npm test
```

Run the local CLI without installing it globally:

```bash
node skills/learn-anything/bin/learn-anything.mjs probe
node skills/learn-anything/bin/learn-anything.mjs create "Rust lifetimes" --root /path/to/project
```

Browser acceptance test:

```bash
npm run test:browser
```

## License

Apache-2.0
