# Real Time Design

```text
██████╗ ███████╗ █████╗ ██╗         ████████╗██╗███╗   ███╗███████╗
██╔══██╗██╔════╝██╔══██╗██║         ╚══██╔══╝██║████╗ ████║██╔════╝
██████╔╝█████╗  ███████║██║            ██║   ██║██╔████╔██║█████╗
██╔══██╗██╔══╝  ██╔══██║██║            ██║   ██║██║╚██╔╝██║██╔══╝
██║  ██║███████╗██║  ██║███████╗       ██║   ██║██║ ╚═╝ ██║███████╗
╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚══════╝       ╚═╝   ╚═╝╚═╝     ╚═╝╚══════╝

██████╗ ███████╗███████╗██╗ ██████╗ ███╗   ██╗
██╔══██╗██╔════╝██╔════╝██║██╔════╝ ████╗  ██║
██║  ██║█████╗  ███████╗██║██║  ███╗██╔██╗ ██║
██║  ██║██╔══╝  ╚════██║██║██║   ██║██║╚██╗██║
██████╔╝███████╗███████║██║╚██████╔╝██║ ╚████║
╚═════╝ ╚══════╝╚══════╝╚═╝ ╚═════╝ ╚═╝  ╚═══╝
```

Real Time Design is a terminal voice surface for coding. You open it in one folder, point it at the repo you want to edit, and talk continuously. OpenAI Realtime listens for coding instructions, turns them into structured tasks, and dispatches those tasks to the local Codex CLI running `gpt-5.3-codex-spark`.

No push-to-talk. No separate transcription step. Speak, correct yourself, interrupt, and let Codex agents work.

## What It Does

- Streams microphone audio to the OpenAI Realtime API.
- Uses semantic VAD to detect when a spoken coding instruction is complete.
- Extracts structured tasks such as `edit header`, `run tests`, or `create component`.
- Starts local `codex exec` agents against the target repo.
- Runs independent voice tasks in parallel.
- Supports barge-in corrections like "actually make it green instead" or "stop that."
- Shows a compact TUI with listening state, created tasks, Codex status, and the current step.

## Quick Start

Install dependencies:

```bash
npm install
```

Create a local `.env`:

```bash
cp .env.example .env
```

Add your key:

```bash
OPENAI_API_KEY=sk-...
```

Run Real Time Design and point it at the repo you want Codex to edit:

```bash
npm run dev -- --cwd /path/to/your/project
```

Example:

```bash
npm run dev -- --cwd /Users/pmarques/Dev/lilapps/bikepark-atlas
```

## Requirements

- Node.js 20+
- A working `codex` CLI login
- OpenAI API key for Realtime voice
- Microphone access in your terminal
- SoX on macOS if local audio capture needs it:

```bash
brew install sox
```

## How It Works

```text
microphone
   │
   ▼
OpenAI Realtime
   │  semantic VAD + structured code_intent tool call
   ▼
Real Time Design scheduler
   │  parallel task dispatch + barge-in handling
   ▼
codex exec -m gpt-5.3-codex-spark
   │
   ▼
local repo edits
```

The voice model never writes code directly. It only decides whether your speech contains an actionable coding task. Real Time Design then routes that task into Codex, which edits the target workspace.

## Controls

- `q` or `Ctrl+C`: quit
- `m`: mute or unmute microphone streaming
- `u`: ask Codex to undo the last change

## Parallel Agents

By default, Real Time Design can run up to four Codex agents at once:

```bash
npm run dev -- --cwd /path/to/project --max-agents 4
```

Separate tasks run in parallel. For example:

```text
"Make the header red."
"Also tighten the card spacing."
"Run the typecheck."
```

Those can become separate Codex runs.

## Barge-In

Correction language interrupts the matching active task:

```text
"Make the header red."
"Actually make it blue instead."
```

The first agent is stopped and restarted with the correction as the source of truth.

Stop language cancels without restarting:

```text
"Stop that."
"Cancel the footer change."
"Never mind."
```

This is heuristic. If you want a separate new task, avoid correction words and name a different target:

```text
"Also update the footer spacing."
```

## Current Status

This is an early prototype. The core loop works:

- Realtime voice session
- Task extraction
- Parallel Codex dispatch
- Barge-in restart/cancel behavior
- Compact task/status TUI

Still rough:

- Barge-in classification is heuristic.
- Codex progress is inferred from CLI output.
- Parallel agents can still conflict if you ask them to edit the same files.
- Realtime session reconnect is basic.

## Safety Notes

Real Time Design can edit files in the target repo. Commit or stash important work before using it heavily.

Secrets belong in `.env`, which is ignored by git. Do not commit API keys.
