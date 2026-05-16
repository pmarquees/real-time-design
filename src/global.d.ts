declare module "node-record-lpcm16" {
  import {Readable} from "node:stream";

  interface RecordOptions {
    sampleRateHertz?: number;
    threshold?: number;
    verbose?: boolean;
    recordProgram?: string;
    channels?: number;
    audioType?: string;
  }

  interface Recording {
    stream(): Readable;
    stop(): void;
  }

  const recorder: {
    record(options?: RecordOptions): Recording;
  };

  export default recorder;
}
