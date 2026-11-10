import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { client, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

const command = process.argv[2] ?? "opencode";
const args = process.argv.slice(3);
if (args.length === 0 && command === "opencode") args.push("acp");

const proc = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });

proc.on("error", (err) => {
  console.error(`failed to spawn ${command}:`, err.message);
  process.exit(1);
});

const stream = ndJsonStream(
  Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>,
  Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>,
);

const app = client({ name: "capability-probe" });

try {
  const result = await app.connectWith(stream, async (agent) => {
    const init = await agent.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "capability-probe", version: "0.0.1" },
    });

    const session = await agent.request("session/new", {
      cwd: process.cwd(),
      mcpServers: [],
    });

    return { initialize: init, sessionNew: session };
  });

  console.log(JSON.stringify(result.initialize, null, 2));
  console.log("session config options:");
  console.log(JSON.stringify(result.sessionNew.configOptions ?? [], null, 2));
} finally {
  proc.kill();
}
