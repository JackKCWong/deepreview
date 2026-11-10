import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import path from "node:path";
import {
  client,
  ndJsonStream,
  PROTOCOL_VERSION,
  type SessionUpdate,
  type StopReason,
} from "@agentclientprotocol/sdk";

export type SessionOptions = {
  mode?: string;
  model?: string;
};

export type DeepReviewOptions = {
  command?: string;
  args?: string[];
  cwd?: string;
  maxNudges?: number;
};

export type DeepReviewResult = {
  readPaths: string[];
  unreadPaths: string[];
  stopReason: StopReason;
  nudges: number;
};

type ToolCallState = { kind?: string; paths: string[] };

function normalizePath(p: string, cwd: string): string {
  if (p.startsWith("file://")) p = new URL(p).pathname;
  return path.resolve(cwd, p);
}

function extractReadPaths(
  update: Extract<SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>,
): string[] {
  const out: string[] = [];
  for (const loc of (update as { locations?: { path: string }[] }).locations ?? []) {
    if (loc.path) out.push(loc.path);
  }
  const raw = (update as { rawInput?: unknown }).rawInput;
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    for (const key of ["filePath", "file_path", "path", "absolutePath"]) {
      if (typeof r[key] === "string") out.push(r[key] as string);
    }
  }
  return out;
}

export type DeepReviewPrompt = {
  user: string;
  nudge: string;
};

export async function deepReview(
  sessionOptions: SessionOptions,
  prompt: DeepReviewPrompt,
  paths: string[],
  onMessage: (update: SessionUpdate) => void,
  options: DeepReviewOptions = {},
): Promise<DeepReviewResult> {
  const cwd = options.cwd ?? process.cwd();
  const command = options.command ?? "opencode";
  const args = options.args ?? (command === "opencode" ? ["acp"] : []);
  const maxNudges = options.maxNudges ?? paths.length + 1;

  const proc = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
  await new Promise<void>((resolve, reject) => {
    proc.once("spawn", resolve);
    proc.once("error", reject);
  });

  const stream = ndJsonStream(
    Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>,
    Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>,
  );

  const toolCalls = new Map<string, ToolCallState>();
  const readSet = new Set<string>();

  const app = client({ name: "deepreview" }).onNotification(
    "session/update",
    ({ params }) => {
      const update = params.update;
      onMessage(update);
      if (
        update.sessionUpdate === "tool_call" ||
        update.sessionUpdate === "tool_call_update"
      ) {
        const state = toolCalls.get(update.toolCallId) ?? { paths: [] };
        if (update.kind) state.kind = update.kind;
        state.paths.push(...extractReadPaths(update));
        toolCalls.set(update.toolCallId, state);
        if (state.kind === "read") {
          for (const p of state.paths) readSet.add(normalizePath(p, cwd));
        }
      }
    },
  );

  const targets = paths.map((p) => normalizePath(p, cwd));

  try {
    return await app.connectWith(stream, async (agent) => {
      await agent.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "deepreview", version: "0.0.1" },
      });

      const { sessionId } = await agent.request("session/new", {
        cwd,
        mcpServers: [],
      });

      for (const [configId, value] of [
        ["mode", sessionOptions.mode],
        ["model", sessionOptions.model],
      ] as const) {
        if (value) {
          await agent.request("session/set_config_option", {
            sessionId,
            configId,
            value,
          });
        }
      }

      const fileList = targets.join("\n");
      const render = (text: string, files: string) =>
        text.replaceAll("{{file_list}}", files);

      let nudges = 0;
      let stopReason: StopReason = "end_turn";

      while (true) {
        const remaining = targets.filter((t) => !readSet.has(t));
        const text =
          nudges === 0
            ? render(prompt.user, fileList)
            : render(prompt.nudge, remaining.join("\n"));

        const res = await agent.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text }],
        });
        stopReason = res.stopReason;

        const unread = targets.filter((t) => !readSet.has(t));
        if (unread.length === 0 || nudges >= maxNudges) break;
        nudges += 1;
      }

      return {
        readPaths: targets.filter((t) => readSet.has(t)),
        unreadPaths: targets.filter((t) => !readSet.has(t)),
        stopReason,
        nudges,
      };
    });
  } finally {
    proc.kill();
  }
}
