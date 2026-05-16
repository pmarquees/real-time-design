#!/usr/bin/env node
import "dotenv/config";
import process from "node:process";
import React, {useEffect, useMemo, useRef, useState} from "react";
import {Command} from "commander";
import {Box, Newline, render, Text, useApp, useInput, useStdin} from "ink";
import {AudioCapture} from "./audio.js";
import {CodexRunner} from "./codex.js";
import {RealtimeVoiceClient} from "./realtime.js";
import type {AppState, CodeIntent, CodexRun, TranscriptLine, VoiceMode} from "./types.js";

const DEFAULT_REALTIME_MODEL = process.env.RTD_REALTIME_MODEL ?? "gpt-realtime-2";
const DEFAULT_CODEX_MODEL = process.env.RTD_CODEX_MODEL ?? "gpt-5.3-codex-spark";

const program = new Command()
  .name("rtd")
  .description("Realtime voice coding terminal that routes OpenAI Realtime intents into Codex CLI")
  .option("-C, --cwd <dir>", "workspace to run Codex in", process.cwd())
  .option("--realtime-model <model>", "Realtime API model", DEFAULT_REALTIME_MODEL)
  .option("--codex-model <model>", "Codex CLI model", DEFAULT_CODEX_MODEL)
  .option("--codex-bin <path>", "Codex executable", "codex")
  .option("--max-agents <count>", "maximum parallel Codex agents", parsePositiveInt, 4)
  .option("--no-audio", "disable microphone capture and run UI only")
  .parse(process.argv);

interface CliOptions {
  cwd: string;
  realtimeModel: string;
  codexModel: string;
  codexBin: string;
  maxAgents: number;
  audio: boolean;
}

const options = program.opts<CliOptions>();

if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is required. Export it in your shell; do not commit it to this repo.");
  process.exit(1);
}

render(<RealtimeDesignApp options={options} />);

function RealtimeDesignApp({options}: {options: CliOptions}) {
  const {exit} = useApp();
  const {isRawModeSupported} = useStdin();
  const voiceRef = useRef<RealtimeVoiceClient>();
  const audioRef = useRef<AudioCapture>();
  const codexRef = useRef<CodexRunner>();
  const [state, setState] = useState<AppState>(() => ({
    cwd: options.cwd,
    realtimeModel: options.realtimeModel,
    codexModel: options.codexModel,
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
      model: options.codexModel,
      codexBin: options.codexBin,
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

    voice.on("intent", (intent: CodeIntent) => {
      codex.enqueue(intent);
      setState((current) => ({
        ...current,
        turns: current.turns + 1,
        lastIntent: intent,
        transcripts: appendTranscript(current.transcripts, intent.description, true),
        statusMessage: `dispatching ${intent.action}${intent.target ? ` ${intent.target}` : ""}`
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
      setState((current) => ({
        ...current,
        usage: {...current.usage, audioBytes: current.usage.audioBytes + frame.length}
      }));
    });

    audio.on("level", (level: number) => {
      setState((current) => ({...current, gain: level}));
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
        activeRuns: upsertRun(current.activeRuns, run),
        statusMessage: `Codex agent started (${current.activeRuns.length + 1}/${options.maxAgents})`,
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
          ? "Codex agent interrupted"
          : run.exitCode === 0 ? "Codex agent finished" : `Codex exited ${run.exitCode ?? "unknown"}`
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
  }, [options.audio, options.codexBin, options.codexModel, options.cwd, options.maxAgents, options.realtimeModel]);

  const visibleRuns = state.activeRuns.length > 0 ? state.activeRuns : state.codexRuns.slice(0, 3);
  const latestTranscript = useMemo(() => state.transcripts.at(-1), [state.transcripts]);

  return (
    <Box flexDirection="column" minHeight={24}>
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
        />
      ) : null}
      <Header state={state} />
      <Box flexDirection="column" borderStyle="round" borderColor={state.voiceMode === "speaking" || state.voiceMode === "transcribing" ? "yellow" : "cyan"} paddingX={1} height={10}>
        <Text color="cyan">Realtime voice</Text>
        <Waveform gain={state.gain} muted={state.muted} mode={state.voiceMode} />
        {latestTranscript ? (
          <Text color={latestTranscript.final ? "gray" : "yellow"}>
            {latestTranscript.final ? "heard" : "hearing"} {truncate(latestTranscript.text, 130)}
          </Text>
        ) : (
          <Text color="gray">Listening for a coding task...</Text>
        )}
      </Box>
      <Box flexDirection="column" borderStyle="round" borderColor={state.activeRuns.length > 0 ? "green" : "gray"} paddingX={1} flexGrow={1} minHeight={12}>
        <Text color="green">Tasks</Text>
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

function KeyboardShortcuts({onQuit, onMute, onUndo}: {onQuit: () => void; onMute: () => void; onUndo: () => void}) {
  useInput((input, key) => {
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
  });

  return null;
}

function Header({state}: {state: AppState}) {
  return (
    <Box justifyContent="space-between">
      <Text bold>real time design</Text>
      <Text color="gray">{state.cwd}</Text>
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
            {index + 1}. {statusIcon(run.status)} {run.status.toUpperCase()} · {run.intent.action}{run.intent.target ? ` · ${run.intent.target}` : ""}
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
      <Text color="gray">
        {audioKb}KB audio · ${realtimeCost.toFixed(2)} est · agents {state.activeRuns.length} · {state.codexModel} · q quit · m mute · u undo
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
