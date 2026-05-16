import {EventEmitter} from "node:events";
import WebSocket from "ws";
import type {CodeIntent} from "./types.js";

interface RealtimeVoiceClientOptions {
  apiKey: string;
  model: string;
  url?: string;
}

type RealtimeStatus =
  | "connecting"
  | "connected"
  | "listening"
  | "speaking"
  | "transcribing"
  | "disconnected"
  | "error";

interface PendingFunctionCall {
  name?: string;
  arguments: string;
}

export class RealtimeVoiceClient extends EventEmitter {
  private socket?: WebSocket;
  private pendingCalls = new Map<string, PendingFunctionCall>();
  private partialTranscript = "";
  private reconnectTimer?: NodeJS.Timeout;
  private manuallyClosed = false;

  constructor(private readonly options: RealtimeVoiceClientOptions) {
    super();
  }

  connect() {
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) {
      return;
    }

    this.manuallyClosed = false;
    this.emitStatus("connecting");
    const url = this.options.url ?? `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(this.options.model)}`;
    this.socket = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`
      }
    });

    this.socket.on("open", () => {
      this.emitStatus("connected");
      this.sendSessionUpdate();
    });
    this.socket.on("message", (data) => this.handleMessage(data.toString()));
    this.socket.on("close", (code, reason) => {
      const message = reason.toString() || `Realtime socket closed with code ${code}`;
      this.emit("close", {code, reason: message});
      this.emitStatus("disconnected");

      if (!this.manuallyClosed) {
        this.reconnectTimer = setTimeout(() => this.connect(), 3000);
      }
    });
    this.socket.on("error", (error) => {
      this.emitStatus("error");
      this.emit("error", error);
    });
  }

  disconnect() {
    this.manuallyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.socket?.close();
    this.socket = undefined;
  }

  appendAudio(frame: Buffer) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    this.send({
      type: "input_audio_buffer.append",
      audio: frame.toString("base64")
    });
  }

  private sendSessionUpdate() {
    this.send({
      type: "session.update",
      session: {
        type: "realtime",
        model: this.options.model,
        output_modalities: ["text"],
        audio: {
          input: {
            format: {type: "audio/pcm", rate: 24000},
            turn_detection: {type: "semantic_vad"}
          }
        },
        tools: [
          {
            type: "function",
            name: "code_intent",
            description: "Structured coding instruction from the user",
            parameters: {
              type: "object",
              properties: {
                action: {
                  type: "string",
                  enum: ["create", "edit", "delete", "explain", "run", "undo"]
                },
                target: {type: "string"},
                description: {type: "string"}
              },
              required: ["action", "description"]
            }
          }
        ],
        tool_choice: "auto",
        instructions: [
          "Extract coding instructions as structured intents.",
          "Never generate code yourself.",
          "If the user is thinking aloud, narrating, or not giving an instruction, wait.",
          "When the instruction is actionable, call code_intent exactly once.",
          "Use action=undo when the user asks to undo, revert, or go back."
        ].join(" ")
      }
    });
  }

  private handleMessage(raw: string) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = String(event.type ?? "");

    if (type === "session.updated") {
      this.emitStatus("listening");
      return;
    }

    if (type === "input_audio_buffer.speech_started") {
      this.emitStatus("speaking");
      return;
    }

    if (type === "input_audio_buffer.speech_stopped" || type === "input_audio_buffer.committed") {
      this.emitStatus("transcribing");
      return;
    }

    if (type === "response.output_text.delta" || type === "conversation.item.input_audio_transcription.delta") {
      const delta = String(event.delta ?? "");
      this.partialTranscript += delta;
      this.emit("transcriptDelta", delta, this.partialTranscript);
      return;
    }

    if (type === "response.output_text.done" || type === "conversation.item.input_audio_transcription.completed") {
      const text = String(event.text ?? event.transcript ?? this.partialTranscript);
      if (text.trim()) {
        this.emit("transcriptDone", text.trim());
      }
      this.partialTranscript = "";
      return;
    }

    this.captureFunctionCall(type, event);

    if (type === "response.done") {
      this.emitStatus("listening");
    }

    if (type === "error") {
      const message = typeof event.error === "object" && event.error
        ? JSON.stringify(event.error)
        : raw;
      this.emit("error", new Error(message));
    }
  }

  private captureFunctionCall(type: string, event: Record<string, unknown>) {
    const callId = String(event.call_id ?? event.item_id ?? event.output_index ?? "default");

    if (type === "response.function_call_arguments.delta") {
      const call = this.pendingCalls.get(callId) ?? {arguments: ""};
      call.arguments += String(event.delta ?? "");
      this.pendingCalls.set(callId, call);
      return;
    }

    if (type === "response.function_call_arguments.done") {
      const call = this.pendingCalls.get(callId) ?? {arguments: ""};
      call.name = String(event.name ?? call.name ?? "code_intent");
      call.arguments = String(event.arguments ?? call.arguments);
      this.pendingCalls.delete(callId);
      this.emitIntent(call);
      return;
    }

    if (type === "response.output_item.done" || type === "conversation.item.done") {
      const item = (event.item ?? event.output_item) as Record<string, unknown> | undefined;
      if (!item || item.type !== "function_call") {
        return;
      }

      this.emitIntent({
        name: String(item.name ?? "code_intent"),
        arguments: String(item.arguments ?? "")
      });
    }
  }

  private emitIntent(call: PendingFunctionCall) {
    if (call.name && call.name !== "code_intent") {
      return;
    }

    try {
      const intent = JSON.parse(call.arguments) as CodeIntent;
      if (intent.description) {
        intent.transcript = this.partialTranscript.trim() || intent.transcript;
        this.emit("intent", intent);
      }
    } catch (error) {
      this.emit("error", new Error(`Could not parse code intent: ${(error as Error).message}`));
    }
  }

  private send(payload: unknown) {
    this.socket?.send(JSON.stringify(payload));
  }

  private emitStatus(status: RealtimeStatus) {
    this.emit("status", status);
  }
}
