import {mkdtempSync, writeFileSync, chmodSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {CodexRunner} from "../dist/codex.js";

const dir = mkdtempSync(join(tmpdir(), "rtd-agent-"));
const fakeAgent = join(dir, "fake-agent");
writeFileSync(fakeAgent, "#!/usr/bin/env bash\nsleep 0.4\nprintf 'done\\n'\n");
chmodSync(fakeAgent, 0o755);

const events = [];
const runner = new CodexRunner({
  cwd: process.cwd(),
  agentCli: "codex",
  codexModel: "fake-codex",
  claudeModel: "fake-claude",
  codexBin: fakeAgent,
  claudeBin: fakeAgent,
  maxParallel: 4
});

runner.on("start", (run) => events.push(["start", run.intent.target]));
runner.on("bargeIn", (run) => events.push(["barge", run.intent.target]));
runner.on("done", (run) => events.push(["done", run.intent.target, run.status]));

runner.enqueue({action: "edit", target: "filter", description: "Change the filter width to 300px"});
runner.enqueue({action: "edit", target: "navigation", description: "Change the navigation to red"});
await wait(900);

const killedIndependent = events.some((event) => event[0] === "barge" || event[2] === "killed");
if (killedIndependent) {
  throw new Error(`independent tasks should not barge in: ${JSON.stringify(events)}`);
}

events.length = 0;
runner.enqueue({action: "edit", target: "header", description: "Change the header to red"});
await wait(50);
runner.enqueue({action: "edit", target: "header", description: "Actually make the header blue instead"});
await wait(900);

const corrected = events.some((event) => event[0] === "barge" && event[1] === "header");
if (!corrected) {
  throw new Error(`targeted correction should barge in: ${JSON.stringify(events)}`);
}

console.log("scheduler smoke passed");

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
