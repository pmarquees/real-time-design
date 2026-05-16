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

Real Time Design is a terminal voice surface for coding. You open it in one folder, point it at the repo you want to edit, and talk continuously. OpenAI Realtime listens for coding instructions, turns them into structured tasks, and dispatches those tasks to a local coding CLI.

Codex is the default backend when installed. Claude CLI is also supported, defaulting to `sonnet`.

No push-to-talk. No separate transcription step. Speak, correct yourself, interrupt, and let coding agents work.

## What It Does

- Streams microphone audio to the OpenAI Realtime API.
- Uses semantic VAD to detect when a spoken coding instruction is complete.
- Extracts structured tasks such as `edit header`, `run tests`, or `create component`.
- Starts local Codex or Claude agents against the target repo.
- Runs independent voice tasks in parallel.
- Supports barge-in corrections like "actually make it green instead" or "stop that."
- Shows a compact TUI with listening state, created tasks, agent status, and the current step.

## Quick Start

Install globally:

```bash
npm install -g real-time-design
```

Create a local `.env` in the repo where you want to use voice coding:

```bash
cd /path/to/your/project
printf "OPENAI_API_KEY=sk-...\n" > .env
```

Make sure at least one coding CLI is installed and logged in:

```bash
codex login
# or
claude auth
```

Start Real Time Design from that project folder:

```bash
rtd
```

Example:

```bash
cd /Users/pmarques/Dev/lilapps/bikepark-atlas
rtd
```

For local development on this repo:

```bash
npm install
npm run dev -- --cwd /path/to/project
```

## Requirements

- Node.js 20+
- A working Codex CLI or Claude CLI login
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
   ├─ or
   ▼
claude --print --model sonnet
   │
   ▼
local repo edits
```

The voice model never writes code directly. It only decides whether your speech contains an actionable coding task. Real Time Design then routes that task into the selected coding CLI, which edits the target workspace.

## Controls

- `q` or `Ctrl+C`: quit
- `m`: mute or unmute microphone streaming
- `u`: ask the selected agent to undo the last change
- `a`: open the agent/model picker for future tasks

In the picker:

- `Up`/`Down` or `j`/`k`: move
- `Enter`: select
- `Esc`: close

## Choosing A Coding CLI

Real Time Design defaults to Codex when both Codex and Claude are installed:

```bash
rtd
```

Pick a backend explicitly:

```bash
rtd --agent codex
rtd --agent claude
```

Customize models:

```bash
rtd --codex-model gpt-5.3-codex-spark
rtd --claude-model sonnet
```

Inside the TUI, press `a` to choose from the installed backend/model combinations. Active tasks keep the model they started with; the picker changes future tasks only.

## Parallel Agents

By default, Real Time Design can run up to four coding agents at once:

```bash
rtd --max-agents 4
```

Separate tasks run in parallel. For example:

```text
"Make the header red."
"Also tighten the card spacing."
"Run the typecheck."
```

Those can become separate agent runs.

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
- Parallel Codex/Claude dispatch
- Barge-in restart/cancel behavior
- Compact task/status TUI

Still rough:

- Barge-in classification is heuristic.
- Agent progress is inferred from CLI output.
- Parallel agents can still conflict if you ask them to edit the same files.
- Realtime session reconnect is basic.

## Safety Notes

Real Time Design can edit files in the target repo. Commit or stash important work before using it heavily.

Secrets belong in `.env`, which is ignored by git. Do not commit API keys.
