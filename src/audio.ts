import {EventEmitter} from "node:events";
import recorder from "node-record-lpcm16";

export interface AudioCaptureOptions {
  sampleRate: number;
  chunkBytes: number;
}

export class AudioCapture extends EventEmitter {
  private recording?: ReturnType<typeof recorder.record>;
  private muted = false;
  private buffer = Buffer.alloc(0);

  constructor(private readonly options: AudioCaptureOptions) {
    super();
  }

  start() {
    if (this.recording) {
      return;
    }

    this.recording = recorder.record({
      sampleRateHertz: this.options.sampleRate,
      threshold: 0,
      verbose: false,
      recordProgram: "rec",
      channels: 1,
      audioType: "raw"
    });

    this.recording.stream()
      .on("data", (chunk: Buffer) => this.handleChunk(chunk))
      .on("error", (error: Error) => this.emit("error", error));
  }

  stop() {
    this.recording?.stop();
    this.recording = undefined;
    this.buffer = Buffer.alloc(0);
  }

  setMuted(muted: boolean) {
    this.muted = muted;
  }

  isMuted() {
    return this.muted;
  }

  private handleChunk(chunk: Buffer) {
    if (this.muted) {
      return;
    }

    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= this.options.chunkBytes) {
      const frame = this.buffer.subarray(0, this.options.chunkBytes);
      this.buffer = this.buffer.subarray(this.options.chunkBytes);
      this.emit("audio", frame);
      this.emit("level", rms(frame));
    }
  }
}

function rms(buffer: Buffer) {
  if (buffer.length < 2) {
    return 0;
  }

  let sum = 0;
  const samples = buffer.length / 2;
  for (let i = 0; i < buffer.length; i += 2) {
    const sample = buffer.readInt16LE(i) / 32768;
    sum += sample * sample;
  }

  return Math.sqrt(sum / samples);
}
