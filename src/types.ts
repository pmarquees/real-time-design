export type VoiceMode =
  | "idle"
  | "connecting"
  | "connected"
  | "listening"
  | "speaking"
  | "transcribing"
  | "disconnected"
  | "error";

export type CodeIntentAction = "create" | "edit" | "delete" | "explain" | "run" | "undo";
export type AgentCli = "codex" | "claude";

export interface CodeIntent {
  action: CodeIntentAction;
  target?: string;
  description: string;
  transcript?: string;
}

export interface TranscriptLine {
  id: string;
  text: string;
  final: boolean;
  createdAt: number;
}

export interface CodexRun {
  id: string;
  intent: CodeIntent;
  startedAt: number;
  finishedAt?: number;
  exitCode?: number | null;
  output: string;
  error?: string;
  status: "running" | "done" | "killed" | "error";
  summary?: string;
  agentCli: AgentCli;
  agentModel: string;
  parentRunId?: string;
  note?: string;
}

export interface UsageEstimate {
  audioBytes: number;
  realtimeTextChars: number;
  codexRuns: number;
  startedAt: number;
}

export interface AppState {
  cwd: string;
  realtimeModel: string;
  codexModel: string;
  claudeModel: string;
  agentCli: AgentCli;
  availableAgents: AgentCli[];
  voiceMode: VoiceMode;
  muted: boolean;
  gain: number;
  turns: number;
  queued: number;
  activeRun?: CodexRun;
  activeRuns: CodexRun[];
  codexRuns: CodexRun[];
  transcripts: TranscriptLine[];
  lastIntent?: CodeIntent;
  statusMessage: string;
  error?: string;
  usage: UsageEstimate;
}
