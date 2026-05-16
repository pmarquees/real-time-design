import {spawn, type ChildProcessWithoutNullStreams} from "node:child_process";
import {EventEmitter} from "node:events";
import type {AgentCli, CodeIntent, CodexRun} from "./types.js";

interface CodexRunnerOptions {
  cwd: string;
  agentCli: AgentCli;
  codexModel: string;
  claudeModel: string;
  codexBin: string;
  claudeBin: string;
  maxParallel: number;
}

interface ActiveProcess {
  run: CodexRun;
  child: ChildProcessWithoutNullStreams;
}

type DispatchDecision =
  | {type: "new"}
  | {type: "restart"; run: CodexRun; reason: string}
  | {type: "cancel"; run: CodexRun; reason: string};

export class CodexRunner extends EventEmitter {
  private queue: CodeIntent[] = [];
  private active = new Map<string, ActiveProcess>();
  private lastRun?: CodexRun;

  constructor(private readonly options: CodexRunnerOptions) {
    super();
  }

  enqueue(intent: CodeIntent) {
    const decision = this.decide(intent);

    if (decision.type === "cancel") {
      this.killRun(decision.run.id, decision.reason);
      this.emit("bargeIn", decision.run, intent, decision.reason);
      return;
    }

    if (decision.type === "restart") {
      const restarted = mergeIntent(decision.run.intent, intent);
      this.killRun(decision.run.id, decision.reason);
      this.emit("bargeIn", decision.run, restarted, decision.reason);
      this.startOrQueue(restarted, decision.run.id, decision.reason);
      return;
    }

    this.startOrQueue(intent);
  }

  getActiveRuns() {
    return [...this.active.values()].map(({run}) => run);
  }

  getLastRun() {
    return this.lastRun;
  }

  stopAll() {
    for (const id of this.active.keys()) {
      this.killRun(id, "shutdown");
    }
    this.queue = [];
    this.emit("queue", this.queue.length);
  }

  private startOrQueue(intent: CodeIntent, parentRunId?: string, note?: string) {
    if (this.active.size >= this.options.maxParallel) {
      this.queue.push(intent);
      this.emit("queue", this.queue.length);
      return;
    }

    this.start(intent, parentRunId, note);
  }

  private start(intent: CodeIntent, parentRunId?: string, note?: string) {
    const run: CodexRun = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      intent,
      startedAt: Date.now(),
      output: "",
      status: "running",
      summary: `starting ${agentLabel(this.options.agentCli)}`,
      agentCli: this.options.agentCli,
      agentModel: this.modelForAgent(),
      parentRunId,
      note
    };
    this.lastRun = run;

    const child = spawn(this.binForAgent(), this.argsForAgent(), {
      cwd: this.options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env
    });

    this.active.set(run.id, {run, child});
    this.emit("start", run);
    this.emitActive();

    child.stdin.end(buildPrompt(intent, this.options.agentCli, note));

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      run.output += text;
      run.summary = summarizeAgentStep(text, run.summary);
      this.emit("delta", run, text);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      run.output += text;
      run.summary = summarizeAgentStep(text, run.summary);
      this.emit("delta", run, text);
    });

    child.on("error", (error) => {
      run.status = "error";
      run.error = error.message;
      this.emit("error", run, error);
    });

    child.on("close", (code, signal) => {
      const wasKilled = run.status === "killed" || signal === "SIGTERM" || signal === "SIGKILL";
      run.exitCode = code;
      run.finishedAt = Date.now();
      run.status = wasKilled ? "killed" : run.error ? "error" : "done";
      run.summary = wasKilled ? (run.note ?? "interrupted") : run.exitCode === 0 ? "finished" : `exited ${run.exitCode ?? "unknown"}`;
      this.active.delete(run.id);
      this.emit("done", run);
      this.emitActive();
      this.drain();
    });
  }

  private drain() {
    while (this.queue.length > 0 && this.active.size < this.options.maxParallel) {
      const intent = this.queue.shift();
      if (intent) {
        this.start(intent);
      }
    }
    this.emit("queue", this.queue.length);
  }

  private decide(intent: CodeIntent): DispatchDecision {
    const activeRuns = this.getActiveRuns();
    if (activeRuns.length === 0) {
      return {type: "new"};
    }

    const target = normalize(intent.target);
    const description = normalize(intent.description);
    const targetMatch = target
      ? activeRuns.find((run) => normalize(run.intent.target) === target)
      : undefined;

    if (isCancellation(description)) {
      const run = targetMatch ?? (target ? undefined : activeRuns.at(-1));
      return run ? {type: "cancel", run, reason: "cancelled by voice"} : {type: "new"};
    }

    if (intent.action === "undo") {
      return {type: "new"};
    }

    if (isBargeIn(description)) {
      const run = targetMatch ?? (isStrongBargeIn(description) && !target ? activeRuns.at(-1) : undefined);
      return run ? {type: "restart", run, reason: "voice correction"} : {type: "new"};
    }

    return {type: "new"};
  }

  private killRun(id: string, reason: string) {
    const active = this.active.get(id);
    if (!active) {
      return;
    }

    active.run.status = "killed";
    active.run.note = reason;
    active.run.finishedAt = Date.now();
    active.child.kill("SIGTERM");
    setTimeout(() => {
      if (this.active.has(id)) {
        active.child.kill("SIGKILL");
      }
    }, 1500).unref();
  }

  private emitActive() {
    this.emit("active", this.getActiveRuns());
  }

  private binForAgent() {
    return this.options.agentCli === "claude" ? this.options.claudeBin : this.options.codexBin;
  }

  private modelForAgent() {
    return this.options.agentCli === "claude" ? this.options.claudeModel : this.options.codexModel;
  }

  private argsForAgent() {
    if (this.options.agentCli === "claude") {
      return [
        "--print",
        "--model",
        this.options.claudeModel,
        "--permission-mode",
        "acceptEdits"
      ];
    }

    return [
      "exec",
      "-m",
      this.options.codexModel,
      "-C",
      this.options.cwd,
      "--skip-git-repo-check",
      "--sandbox",
      "workspace-write",
      "-"
    ];
  }
}

function buildPrompt(intent: CodeIntent, agentCli: AgentCli, note?: string) {
  if (intent.action === "undo") {
    return [
      "Undo the most recent code change you made in this workspace.",
      "Inspect the current working tree first and only revert your own last change.",
      "Do not remove unrelated user changes."
    ].join("\n");
  }

  return [
    "You are being driven by a realtime voice coding terminal called Real Time Design.",
    `Act on the user's finalized voice instruction in this local workspace using ${agentLabel(agentCli)}.`,
    "Make the requested code changes directly. Keep scope tight and preserve unrelated work.",
    "Other coding agents may be running in parallel in this same workspace.",
    "Before editing, inspect the relevant files and avoid overwriting unrelated concurrent changes.",
    "When finished, briefly summarize changed files and validation performed.",
    note ? `Dispatch note: ${note}` : undefined,
    "",
    `Action: ${intent.action}`,
    intent.target ? `Target: ${intent.target}` : undefined,
    `Instruction: ${intent.description}`,
    intent.transcript ? `Transcript: ${intent.transcript}` : undefined
  ].filter(Boolean).join("\n");
}

function mergeIntent(previous: CodeIntent, next: CodeIntent): CodeIntent {
  const target = next.target ?? previous.target;
  return {
    action: next.action === "undo" ? previous.action : next.action,
    target,
    description: [
      "Barge-in update while a previous agent was still running.",
      `Previous instruction: ${previous.description}`,
      `New instruction: ${next.description}`,
      "Apply the new instruction as the source of truth. Do not preserve parts of the previous instruction that conflict with it."
    ].join(" "),
    transcript: next.transcript
  };
}

function normalize(value?: string) {
  return value?.trim().toLowerCase().replace(/\s+/g, " ") ?? "";
}

function isCancellation(description: string) {
  return /\b(stop|cancel|kill|abort|never mind|nevermind|forget it|ignore that|don't do that|do not do that)\b/.test(description);
}

function isBargeIn(description: string) {
  return /\b(actually|instead|rather|make that|scratch that|correction|i mean|no,|not that)\b/.test(description);
}

function isStrongBargeIn(description: string) {
  return /\b(scratch that|never mind that|nevermind that|ignore that|replace that|start over|instead of that|no,? actually)\b/.test(description);
}

function summarizeAgentStep(text: string, previous = "working") {
  const lines = text
    .split(/\r?\n/)
    .map((line) => stripAnsi(line).trim())
    .filter(Boolean);

  for (const line of lines.reverse()) {
    const toolMatch = line.match(/^(exec|apply_patch|read|write|search|update_plan|codex|claude|bash|edit|read)\b[:\s-]*(.*)$/i);
    if (toolMatch) {
      return compact(`${toolMatch[1].toLowerCase()} ${toolMatch[2] ?? ""}`);
    }

    const fileMatch = line.match(/(?:Update File|Add File|Delete File|reading|editing|modified|created)\s*:?\s+(.+)$/i);
    if (fileMatch) {
      return compact(`editing ${fileMatch[1]}`);
    }

    const commandMatch = line.match(/^\$?\s*(npm|pnpm|yarn|bun|node|python|pytest|rg|sed|cat|git|swift|xcodebuild)\b(.{0,80})/);
    if (commandMatch) {
      return compact(`running ${commandMatch[1]}${commandMatch[2]}`);
    }
  }

  return previous;
}

function stripAnsi(value: string) {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function compact(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 120);
}

function agentLabel(agentCli: AgentCli) {
  return agentCli === "claude" ? "Claude" : "Codex";
}
