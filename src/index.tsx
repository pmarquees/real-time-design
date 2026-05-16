#!/usr/bin/env node
import "dotenv/config";
import {spawnSync} from "node:child_process";
import process from "node:process";
import React, {useEffect, useMemo, useRef, useState} from "react";
import {Command} from "commander";
import {Box, Newline, render, Text, useApp, useInput, useStdin} from "ink";
import {AudioCapture} from "./audio.js";
import {CodexRunner} from "./codex.js";
import {RealtimeVoiceClient} from "./realtime.js";
import type {AgentCli, AppState, CodeIntent, CodexRun, TranscriptLine, VoiceMode} from "./types.js";

const DEFAULT_REALTIME_MODEL = process.env.RTD_REALTIME_MODEL ?? "gpt-realtime-2";
const DEFAULT_CODEX_MODEL = process.env.RTD_CODEX_MODEL ?? "gpt-5.3-codex-spark";
const DEFAULT_CLAUDE_MODEL = process.env.RTD_CLAUDE_MODEL ?? "sonnet";
const DEFAULT_CODEX_MODELS = ["gpt-5.3-codex-spark", "gpt-5.4", "gpt-5.5"];
const DEFAULT_CLAUDE_MODELS = ["sonnet", "opus", "haiku"];

const program = new Command()
  .name("rtd")
  .description("Realtime voice coding terminal that routes OpenAI Realtime intents into a local coding CLI")
  .option("-C, --cwd <dir>", "workspace to run the coding agent in", process.cwd())
  .option("--realtime-model <model>", "Realtime API model", DEFAULT_REALTIME_MODEL)
  .option("--codex-model <model>", "Codex CLI model", DEFAULT_CODEX_MODEL)
  .option("--claude-model <model>", "Claude CLI model", DEFAULT_CLAUDE_MODEL)
  .option("--agent <agent>", "coding agent CLI: auto, codex, or claude", parseAgentChoice, "auto")
  .option("--codex-bin <path>", "Codex executable", "codex")
  .option("--claude-bin <path>", "Claude executable", "claude")
  .option("--max-agents <count>", "maximum parallel coding agents", parsePositiveInt, 4)
  .option("--no-audio", "disable microphone capture and run UI only")
  .parse(process.argv);

interface CliOptions {
  cwd: string;
  realtimeModel: string;
  codexModel: string;
  claudeModel: string;
  agent: "auto" | AgentCli;
  codexBin: string;
  claudeBin: string;
  maxAgents: number;
  audio: boolean;
}

interface ModelChoice {
  agentCli: AgentCli;
  model: string;
}

const options = program.opts<CliOptions>();
const availableAgents = detectAvailableAgents(options);
const initialAgent = resolveInitialAgent(options.agent, availableAgents);
const modelChoices = buildModelChoices(options, availableAgents);
const useAlternateScreen = process.stdout.isTTY && process.env.RTD_NO_ALT_SCREEN !== "1";

if (useAlternateScreen) {
  process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H");
  process.once("exit", () => {
    process.stdout.write("\x1b[?25h\x1b[?1049l");
  });
}

render(
  <TerminalScreen>
    {process.env.OPENAI_API_KEY && availableAgents.length > 0 ? (
      <RealtimeDesignApp options={options} availableAgents={availableAgents} initialAgent={initialAgent} />
    ) : process.env.OPENAI_API_KEY ? (
      <AgentSetupApp cwd={options.cwd} />
    ) : (
      <OnboardingApp cwd={options.cwd} availableAgents={availableAgents} />
    )}
  </TerminalScreen>
);

function TerminalScreen({children}: {children: React.ReactNode}) {
  useEffect(() => {
    if (!useAlternateScreen) {
      return;
    }

    return () => {
      process.stdout.write("\x1b[?25h\x1b[?1049l");
    };
  }, []);

  return <>{children}</>;
}

function OnboardingApp({cwd, availableAgents}: {cwd: string; availableAgents: AgentCli[]}) {
  const {exit} = useApp();
  const {isRawModeSupported} = useStdin();

  if (isRawModeSupported) {
    useInput((input, key) => {
      if (input === "q" || key.escape || (key.ctrl && input === "c")) {
        exit();
      }
    });
  }

  return (
    <Box flexDirection="column" minHeight={18}>
      <Box justifyContent="space-between">
        <Text bold>real time design</Text>
        <Text color="gray">{cwd}</Text>
      </Box>
      <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
        <Text color="yellow">OpenAI Realtime key needed</Text>
        <Newline />
        <Text>Real Time Design uses OpenAI Realtime for the always-on voice layer.</Text>
        <Text>Set an API key, then run `rtd` again from the repo you want to edit.</Text>
        <Newline />
        <Text color="cyan">One-time shell setup:</Text>
        <Text>  export OPENAI_API_KEY="sk-..."</Text>
        <Newline />
        <Text color="cyan">Or create a local .env in this project:</Text>
        <Text>  printf 'OPENAI_API_KEY=sk-...\n' &gt; .env</Text>
        <Newline />
        <Text color="gray">Installed coding CLIs: {availableAgents.length > 0 ? availableAgents.join(", ") : "none detected"}</Text>
        <Text color="gray">Also make sure at least one coding CLI is signed in: `codex login` or `claude auth`</Text>
        <Text color="gray">{isRawModeSupported ? "Press q to quit." : "Quit with Ctrl+C."}</Text>
      </Box>
    </Box>
  );
}

function AgentSetupApp({cwd}: {cwd: string}) {
  const {exit} = useApp();
  const {isRawModeSupported} = useStdin();

  if (isRawModeSupported) {
    useInput((input, key) => {
      if (input === "q" || key.escape || (key.ctrl && input === "c")) {
        exit();
      }
    });
  }

  return (
    <Box flexDirection="column" minHeight={14}>
      <Box justifyContent="space-between">
        <Text bold>real time design</Text>
        <Text color="gray">{cwd}</Text>
      </Box>
      <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
        <Text color="yellow">Coding CLI needed</Text>
        <Newline />
        <Text>Real Time Design needs Codex CLI or Claude CLI to edit files.</Text>
        <Text>Install and sign in to at least one of them, then run `rtd` again.</Text>
        <Newline />
        <Text color="cyan">Preferred:</Text>
        <Text>  codex login</Text>
        <Newline />
        <Text color="cyan">Also supported:</Text>
        <Text>  claude auth</Text>
        <Text color="gray">{isRawModeSupported ? "Press q to quit." : "Quit with Ctrl+C."}</Text>
      </Box>
    </Box>
  );
}

function RealtimeDesignApp({options, availableAgents, initialAgent}: {options: CliOptions; availableAgents: AgentCli[]; initialAgent: AgentCli}) {
  const {exit} = useApp();
  const {isRawModeSupported} = useStdin();
  const voiceRef = useRef<RealtimeVoiceClient>();
  const audioRef = useRef<AudioCapture>();
  const codexRef = useRef<CodexRunner>();
  const audioBytesRef = useRef(0);
  const lastAudioPaintRef = useRef(0);
  const recentIntentKeysRef = useRef(new Map<string, number>());
  const [agentCli, setAgentCli] = useState<AgentCli>(initialAgent);
  const [codexModel, setCodexModel] = useState(options.codexModel);
  const [claudeModel, setClaudeModel] = useState(options.claudeModel);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelPickerIndex, setModelPickerIndex] = useState(() => initialModelChoiceIndex(modelChoices, initialAgent, options));
  const [state, setState] = useState<AppState>(() => ({
    cwd: options.cwd,
    realtimeModel: options.realtimeModel,
    codexModel,
    claudeModel,
    agentCli: initialAgent,
    availableAgents,
    voiceMode: "connecting",
    muted: false,
    gain: 0,
    turns: 0,
    queued: 0,
    activeRuns: [],
    codexRuns: [],
    transcripts: [],
    statusMessage: "starting realtime session",
    usage: {
      audioBytes: 0,
      realtimeTextChars: 0,
      codexRuns: 0,
      startedAt: Date.now()
    }
  }));

  useEffect(() => {
    const voice = new RealtimeVoiceClient({
      apiKey: process.env.OPENAI_API_KEY!,
      model: options.realtimeModel
    });
    const codex = new CodexRunner({
      cwd: options.cwd,
      agentCli,
      codexModel,
      claudeModel,
      codexBin: options.codexBin,
      claudeBin: options.claudeBin,
      maxParallel: options.maxAgents
    });
    const audio = new AudioCapture({sampleRate: 24000, chunkBytes: 960});

    voiceRef.current = voice;
    codexRef.current = codex;
    audioRef.current = audio;

    voice.on("status", (status: VoiceMode) => {
      setState((current) => ({
        ...current,
        voiceMode: status,
        statusMessage: statusLabel(status)
      }));
    });

    voice.on("transcriptDelta", (delta: string, full: string) => {
      setState((current) => ({
        ...current,
        transcripts: upsertPartialTranscript(current.transcripts, full),
        usage: {
          ...current.usage,
          realtimeTextChars: current.usage.realtimeTextChars + delta.length
        }
      }));
    });

    voice.on("transcriptDone", (text: string) => {
      setState((current) => ({
        ...current,
        transcripts: finalizeTranscript(current.transcripts, text)
      }));
    });

    voice.on("intents", (intents: CodeIntent[]) => {
      const uniqueIntents = dedupeRecentIntents(intents, recentIntentKeysRef.current);
      if (uniqueIntents.length === 0) {
        return;
      }

      for (const intent of uniqueIntents) {
        codex.enqueue(intent);
      }
      const lastIntent = uniqueIntents.at(-1);
      setState((current) => ({
        ...current,
        turns: current.turns + uniqueIntents.length,
        lastIntent,
        transcripts: uniqueIntents.reduce(
          (lines, intent) => appendTranscript(lines, intent.description, true),
          current.transcripts
        ),
        statusMessage: uniqueIntents.length === 1
          ? `dispatching ${lastIntent?.action}${lastIntent?.target ? ` ${lastIntent.target}` : ""}`
          : `dispatching ${uniqueIntents.length} tasks`
      }));
    });

    voice.on("error", (error: Error) => {
      setState((current) => ({
        ...current,
        voiceMode: "error",
        error: error.message,
        statusMessage: "realtime error"
      }));
    });

    voice.on("close", ({code, reason}: {code: number; reason: string}) => {
      setState((current) => ({
        ...current,
        statusMessage: `disconnected (${code})`,
        error: reason
      }));
    });

    audio.on("audio", (frame: Buffer) => {
      voice.appendAudio(frame);
      audioBytesRef.current += frame.length;
    });

    audio.on("level", (level: number) => {
      const now = Date.now();
      if (now - lastAudioPaintRef.current < 120) {
        return;
      }

      lastAudioPaintRef.current = now;
      setState((current) => ({
        ...current,
        gain: level,
        usage: {...current.usage, audioBytes: audioBytesRef.current}
      }));
    });

    audio.on("error", (error: Error) => {
      setState((current) => ({
        ...current,
        error: error.message,
        statusMessage: "audio capture error"
      }));
    });

    codex.on("queue", (queued: number) => {
      setState((current) => ({...current, queued}));
    });

    codex.on("start", (run: CodexRun) => {
      setState((current) => ({
        ...current,
        activeRun: run,
        agentCli,
        activeRuns: upsertRun(current.activeRuns, run),
        statusMessage: `${agentLabel(run.agentCli)} agent started (${current.activeRuns.length + 1}/${options.maxAgents})`,
        usage: {...current.usage, codexRuns: current.usage.codexRuns + 1}
      }));
    });

    codex.on("delta", (run: CodexRun) => {
      setState((current) => ({
        ...current,
        activeRun: {...run},
        activeRuns: upsertRun(current.activeRuns, run)
      }));
    });

    codex.on("active", (runs: CodexRun[]) => {
      setState((current) => ({
        ...current,
        activeRuns: runs.map((run) => ({...run})),
        activeRun: runs.at(-1) ? {...runs.at(-1)!} : current.activeRun
      }));
    });

    codex.on("bargeIn", (oldRun: CodexRun, nextIntent: CodeIntent, reason: string) => {
      setState((current) => ({
        ...current,
        activeRuns: current.activeRuns.filter((run) => run.id !== oldRun.id),
        codexRuns: [{...oldRun}, ...current.codexRuns].slice(0, 10),
        lastIntent: nextIntent,
        statusMessage: `barge-in: ${reason}`
      }));
    });

    codex.on("done", (run: CodexRun) => {
      setState((current) => ({
        ...current,
        activeRun: current.activeRun?.id === run.id ? current.activeRuns.find((active) => active.id !== run.id) : current.activeRun,
        activeRuns: current.activeRuns.filter((active) => active.id !== run.id),
        codexRuns: [run, ...current.codexRuns].slice(0, 10),
        statusMessage: run.status === "killed"
          ? `${agentLabel(run.agentCli)} agent interrupted`
          : run.exitCode === 0 ? `${agentLabel(run.agentCli)} agent finished` : `${agentLabel(run.agentCli)} exited ${run.exitCode ?? "unknown"}`
      }));
    });

    codex.on("error", (run: CodexRun, error: Error) => {
      setState((current) => ({
        ...current,
        activeRun: {...run, error: error.message},
        activeRuns: upsertRun(current.activeRuns, {...run, error: error.message}),
        error: error.message,
        statusMessage: "Codex error"
      }));
    });

    voice.connect();
    if (options.audio) {
      audio.start();
    }

    return () => {
      audio.stop();
      voice.disconnect();
      codex.stopAll();
    };
  }, [agentCli, claudeModel, codexModel, options.audio, options.claudeBin, options.codexBin, options.cwd, options.maxAgents, options.realtimeModel]);

  const visibleRuns = state.activeRuns.length > 0 ? state.activeRuns : state.codexRuns.slice(0, 3);
  const latestTranscript = useMemo(() => state.transcripts.at(-1), [state.transcripts]);
  const terminalRows = process.stdout.rows && process.stdout.rows > 0 ? process.stdout.rows : 30;
  const appHeight = Math.max(20, terminalRows - 1);
  const taskHeight = Math.max(8, appHeight - 12);

  return (
    <Box flexDirection="column" height={appHeight}>
      {isRawModeSupported ? (
        <KeyboardShortcuts
          onQuit={() => {
            audioRef.current?.stop();
            voiceRef.current?.disconnect();
            exit();
          }}
          onMute={() => {
            const nextMuted = !audioRef.current?.isMuted();
            audioRef.current?.setMuted(nextMuted);
            setState((current) => ({
              ...current,
              muted: nextMuted,
              statusMessage: nextMuted ? "microphone muted" : "microphone live"
            }));
          }}
          onUndo={() => {
            const intent: CodeIntent = {action: "undo", description: "Undo the last change"};
            codexRef.current?.enqueue(intent);
            setState((current) => ({...current, lastIntent: intent, statusMessage: "queued undo"}));
          }}
          pickerOpen={modelPickerOpen}
          pickerCount={modelChoices.length}
          onOpenPicker={() => {
            if (state.activeRuns.length > 0) {
              setState((current) => ({...current, statusMessage: "finish active tasks before changing model"}));
              return;
            }

            setModelPickerOpen(true);
            setModelPickerIndex(currentModelChoiceIndex(modelChoices, agentCli, agentCli === "claude" ? claudeModel : codexModel));
          }}
          onClosePicker={() => setModelPickerOpen(false)}
          onMovePicker={(delta) => {
            setModelPickerIndex((current) => wrapIndex(current + delta, modelChoices.length));
          }}
          onSelectPicker={() => {
            const choice = modelChoices[modelPickerIndex];
            if (!choice) {
              return;
            }

            setAgentCli(choice.agentCli);
            if (choice.agentCli === "codex") {
              setCodexModel(choice.model);
            } else {
              setClaudeModel(choice.model);
            }
            setState((current) => ({
              ...current,
              agentCli: choice.agentCli,
              codexModel: choice.agentCli === "codex" ? choice.model : current.codexModel,
              claudeModel: choice.agentCli === "claude" ? choice.model : current.claudeModel,
              statusMessage: `selected ${agentLabel(choice.agentCli)} ${choice.model}`
            }));
            setModelPickerOpen(false);
          }}
        />
      ) : null}
      <Box flexDirection="column" borderStyle="round" borderColor={state.voiceMode === "speaking" || state.voiceMode === "transcribing" ? "yellow" : "cyan"} paddingX={1} height={10}>
        <Box justifyContent="space-between">
          <Text color="cyan">real time design</Text>
          <Text color="gray" wrap="truncate-middle">{state.cwd}</Text>
        </Box>
        <Waveform gain={state.gain} muted={state.muted} mode={state.voiceMode} />
        {latestTranscript ? (
          <Text color={latestTranscript.final ? "gray" : "yellow"}>
            {latestTranscript.final ? "heard" : "hearing"} {truncate(latestTranscript.text, 130)}
          </Text>
        ) : (
          <Text color="gray">Listening for a coding task...</Text>
        )}
      </Box>
      <Box flexDirection="column" borderStyle="round" borderColor={state.activeRuns.length > 0 ? "green" : "gray"} paddingX={1} height={taskHeight}>
        <Text color="green">Tasks</Text>
        {modelPickerOpen ? (
          <ModelPicker choices={modelChoices} selectedIndex={modelPickerIndex} />
        ) : null}
        {visibleRuns.length > 0 ? <TaskList runs={visibleRuns} /> : <Text color="gray">No tasks dispatched yet.</Text>}
        {state.error ? (
          <>
            <Newline />
            <Text color="red">Error: {state.error}</Text>
          </>
        ) : null}
      </Box>
      <StatusBar state={state} />
    </Box>
  );
}

function KeyboardShortcuts({
  onQuit,
  onMute,
  onUndo,
  pickerOpen,
  pickerCount,
  onOpenPicker,
  onClosePicker,
  onMovePicker,
  onSelectPicker
}: {
  onQuit: () => void;
  onMute: () => void;
  onUndo: () => void;
  pickerOpen: boolean;
  pickerCount: number;
  onOpenPicker: () => void;
  onClosePicker: () => void;
  onMovePicker: (delta: number) => void;
  onSelectPicker: () => void;
}) {
  useInput((input, key) => {
    if (pickerOpen) {
      if (key.escape || input === "a") {
        onClosePicker();
        return;
      }
      if (key.return) {
        onSelectPicker();
        return;
      }
      if (key.upArrow || input === "k") {
        onMovePicker(-1);
        return;
      }
      if (key.downArrow || input === "j") {
        onMovePicker(1);
        return;
      }
    }

    if (input === "q" || key.escape || (key.ctrl && input === "c")) {
      onQuit();
      return;
    }

    if (input === "m") {
      onMute();
    }

    if (input === "u") {
      onUndo();
    }

    if (input === "a") {
      if (pickerCount === 0) {
        return;
      }
      onOpenPicker();
    }
  });

  return null;
}

function ModelPicker({choices, selectedIndex}: {choices: ModelChoice[]; selectedIndex: number}) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1} marginBottom={1}>
      <Text color="cyan">Choose agent/model for future tasks</Text>
      {choices.map((choice, index) => (
        <Text key={`${choice.agentCli}-${choice.model}`} color={index === selectedIndex ? "yellow" : "gray"}>
          {index === selectedIndex ? "> " : "  "}{agentLabel(choice.agentCli)} · {choice.model}
        </Text>
      ))}
      <Text color="gray">↑/↓ or j/k move · Enter select · Esc close</Text>
    </Box>
  );
}

function Waveform({gain, muted, mode}: {gain: number; muted: boolean; mode: VoiceMode}) {
  const width = 72;
  const energy = Math.max(1, Math.min(width, Math.round(gain * 260)));
  const phase = Date.now() / 120;
  const glyphs = Array.from({length: width}, (_, index) => {
    const wave = Math.sin(index / 2.2 + phase);
    const active = index < energy || mode === "speaking" || mode === "transcribing";
    if (!active) {
      return "·";
    }
    if (wave > 0.62) return "█";
    if (wave > 0.15) return "▓";
    if (wave > -0.35) return "▒";
    return "░";
  }).join("");
  const label = muted ? "muted" : mode === "speaking" ? "catching voice" : mode === "transcribing" ? "forming task" : "listening";
  return (
    <Box flexDirection="column">
      <Text color={muted ? "gray" : mode === "listening" ? "cyan" : "yellow"}>{label}</Text>
      <Text color={muted ? "gray" : "yellow"}>{glyphs}</Text>
    </Box>
  );
}

function TaskList({runs}: {runs: CodexRun[]}) {
  return (
    <Box flexDirection="column">
      {runs.map((run, index) => (
        <Box key={run.id} flexDirection="column" marginBottom={1}>
          <Text color={statusColor(run.status)}>
            {index + 1}. {statusIcon(run.status)} {run.status.toUpperCase()} · {agentLabel(run.agentCli)} · {run.intent.action}{run.intent.target ? ` · ${run.intent.target}` : ""}
          </Text>
          <Text>{truncate(run.intent.description, 130)}</Text>
          <Text color="gray">step: {run.summary ?? (run.status === "running" ? "working" : run.status)}</Text>
        </Box>
      ))}
    </Box>
  );
}

function StatusBar({state}: {state: AppState}) {
  const minutes = Math.max(0, (Date.now() - state.usage.startedAt) / 60000);
  const realtimeCost = minutes * 0.06;
  const audioKb = (state.usage.audioBytes / 1024).toFixed(1);
  const modeColor = state.voiceMode === "error" || state.voiceMode === "disconnected" ? "red" : "green";

  return (
    <Box justifyContent="space-between">
      <Text>
        <Text color={modeColor}>{stateSymbol(state.voiceMode)} {state.statusMessage}</Text>
        {"  "}
        <Text color="gray">turns {state.turns} queued {state.queued}</Text>
      </Text>
      <Text color="gray" wrap="truncate-start">
        {audioKb}KB · ${realtimeCost.toFixed(2)} · {agentLabel(state.agentCli)} {state.agentCli === "claude" ? state.claudeModel : state.codexModel} · agents {state.activeRuns.length} · q/m/u/a
      </Text>
    </Box>
  );
}

function upsertRun(runs: CodexRun[], run: CodexRun) {
  const copy = {...run};
  const exists = runs.some((current) => current.id === run.id);
  if (!exists) {
    return [...runs, copy];
  }

  return runs.map((current) => current.id === run.id ? copy : current);
}

function upsertPartialTranscript(lines: TranscriptLine[], text: string) {
  const partial = lines.find((line) => !line.final);
  if (!partial) {
    return appendTranscript(lines, text, false);
  }

  return lines.map((line) => line.id === partial.id ? {...line, text} : line);
}

function finalizeTranscript(lines: TranscriptLine[], text: string) {
  const partial = lines.find((line) => !line.final);
  if (!partial) {
    return appendTranscript(lines, text, true);
  }

  return lines.map((line) => line.id === partial.id ? {...line, text, final: true} : line);
}

function appendTranscript(lines: TranscriptLine[], text: string, final: boolean) {
  return [
    ...lines.filter((line) => line.text !== text || line.final !== final),
    {id: `${Date.now()}-${Math.random()}`, text, final, createdAt: Date.now()}
  ].slice(-20);
}

function dedupeRecentIntents(intents: CodeIntent[], recent: Map<string, number>) {
  const now = Date.now();
  const windowMs = 6000;
  for (const [key, timestamp] of recent) {
    if (now - timestamp > windowMs) {
      recent.delete(key);
    }
  }

  const unique: CodeIntent[] = [];
  const batchKeys = new Set<string>();
  for (const intent of intents) {
    const key = intentKey(intent);
    if (batchKeys.has(key) || recent.has(key)) {
      continue;
    }

    batchKeys.add(key);
    recent.set(key, now);
    unique.push(intent);
  }

  return unique;
}

function intentKey(intent: CodeIntent) {
  return [
    intent.action,
    normalizeText(intent.target),
    normalizeText(intent.description)
  ].join("|");
}

function normalizeText(value?: string) {
  return value?.trim().toLowerCase().replace(/\s+/g, " ") ?? "";
}

function statusLabel(status: VoiceMode) {
  switch (status) {
    case "connecting":
      return "connecting to Realtime";
    case "listening":
      return "listening";
    case "speaking":
      return "speech detected";
    case "transcribing":
      return "transcribing";
    case "disconnected":
      return "disconnected";
    case "error":
      return "error";
    default:
      return status;
  }
}

function stateSymbol(status: VoiceMode) {
  switch (status) {
    case "listening":
      return "●";
    case "speaking":
    case "transcribing":
      return "◐";
    case "error":
    case "disconnected":
      return "●";
    default:
      return "○";
  }
}

function truncate(text: string, maxChars: number) {
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

function statusIcon(status: CodexRun["status"]) {
  switch (status) {
    case "running":
      return ">";
    case "done":
      return "✓";
    case "killed":
      return "!";
    case "error":
      return "x";
  }
}

function statusColor(status: CodexRun["status"]) {
  switch (status) {
    case "running":
      return "green";
    case "done":
      return "cyan";
    case "killed":
      return "yellow";
    case "error":
      return "red";
  }
}

function parsePositiveInt(value: string) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error("--max-agents must be a positive integer");
  }
  return parsed;
}

function parseAgentChoice(value: string) {
  if (value === "auto" || value === "codex" || value === "claude") {
    return value;
  }

  throw new Error("--agent must be auto, codex, or claude");
}

function detectAvailableAgents(options: CliOptions): AgentCli[] {
  return [
    commandExists(options.codexBin) ? "codex" : undefined,
    commandExists(options.claudeBin) ? "claude" : undefined
  ].filter(Boolean) as AgentCli[];
}

function commandExists(command: string) {
  const result = spawnSync("sh", ["-lc", `command -v ${shellQuote(command)}`], {stdio: "ignore"});
  return result.status === 0;
}

function resolveInitialAgent(requested: "auto" | AgentCli, availableAgents: AgentCli[]) {
  if (requested !== "auto") {
    return requested;
  }

  if (availableAgents.includes("codex")) {
    return "codex";
  }

  if (availableAgents.includes("claude")) {
    return "claude";
  }

  return "codex";
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function agentLabel(agentCli: AgentCli) {
  return agentCli === "claude" ? "Claude" : "Codex";
}

function buildModelChoices(options: CliOptions, availableAgents: AgentCli[]): ModelChoice[] {
  const choices: ModelChoice[] = [];
  if (availableAgents.includes("codex")) {
    for (const model of unique([options.codexModel, ...DEFAULT_CODEX_MODELS])) {
      choices.push({agentCli: "codex", model});
    }
  }

  if (availableAgents.includes("claude")) {
    for (const model of unique([options.claudeModel, ...DEFAULT_CLAUDE_MODELS])) {
      choices.push({agentCli: "claude", model});
    }
  }

  return choices;
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function initialModelChoiceIndex(choices: ModelChoice[], initialAgent: AgentCli, options: CliOptions) {
  return currentModelChoiceIndex(
    choices,
    initialAgent,
    initialAgent === "claude" ? options.claudeModel : options.codexModel
  );
}

function currentModelChoiceIndex(choices: ModelChoice[], agentCli: AgentCli, model: string) {
  const index = choices.findIndex((choice) => choice.agentCli === agentCli && choice.model === model);
  return index >= 0 ? index : 0;
}

function wrapIndex(index: number, length: number) {
  if (length <= 0) {
    return 0;
  }

  return ((index % length) + length) % length;
}
