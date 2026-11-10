import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import {
  client,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ContentBlock,
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
  opencodeCwd?: string;
  sessionCwd?: string;
  maxNudges?: number;
  minPct?: number;
};

export type DeepReviewResult = {
  readPaths: string[];
  unreadPaths: string[];
  stopReason: StopReason;
  nudges: number;
};

type ReadChunk = { path: string; offset?: number; limit?: number };
type ToolCallState = { kind?: string; chunks: ReadChunk[] };

function normalizePath(p: string, cwd: string): string {
  if (p.startsWith("file://")) p = new URL(p).pathname;
  return path.resolve(cwd, p);
}

function extractReadChunks(
  update: Extract<SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>,
): ReadChunk[] {
  const out: ReadChunk[] = [];
  const raw = (update as { rawInput?: unknown }).rawInput;
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    for (const key of ["filePath", "file_path", "path", "absolutePath"]) {
      if (typeof r[key] === "string") {
        out.push({
          path: r[key] as string,
          offset: typeof r.offset === "number" ? r.offset : undefined,
          limit: typeof r.limit === "number" ? r.limit : undefined,
        });
      }
    }
  }
  if (out.length > 0) return out;
  for (const loc of (update as { locations?: { path: string }[] }).locations ?? []) {
    if (loc.path) out.push({ path: loc.path });
  }
  return out;
}

function countLines(file: string): number {
  try {
    const content = fs.readFileSync(file, "utf8");
    if (content.length === 0) return 0;
    return content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
  } catch {
    return 1;
  }
}

type LineIntervals = { start: number; end: number }[];

function addInterval(intervals: LineIntervals, start: number, end: number): void {
  intervals.push({ start, end });
  intervals.sort((a, b) => a.start - b.start);
  for (let i = 0; i < intervals.length - 1; i++) {
    if (intervals[i].end >= intervals[i + 1].start) {
      intervals[i].end = Math.max(intervals[i].end, intervals[i + 1].end);
      intervals.splice(i + 1, 1);
      i--;
    }
  }
}

function coveredLines(intervals: LineIntervals): number {
  return intervals.reduce((sum, i) => sum + (i.end - i.start), 0);
}

function extractMentionPaths(text: string, cwd: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(/@([^\s@]+)/g)) {
    const mention = match[1].replace(/[.,;:!?)\]]+$/, "");
    if (!mention) continue;
    const p = normalizePath(mention, cwd);
    try {
      if (fs.statSync(p).isFile()) seen.add(p);
    } catch {
      continue;
    }
  }
  return [...seen];
}

function mentionToResource(p: string): ContentBlock {
  return {
    type: "resource",
    resource: { uri: `file://${p}`, text: fs.readFileSync(p, "utf8") },
  };
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
  const opencodeCwd = options.opencodeCwd ?? cwd;
  const sessionCwd = options.sessionCwd ?? cwd;
  const command = options.command ?? "opencode";
  const args = options.args ?? (command === "opencode" ? ["acp"] : []);
  const maxNudges = options.maxNudges ?? paths.length + 1;
  const minPct = Math.min(100, Math.max(1, options.minPct ?? 60));

  const proc = spawn(command, args, {
    cwd: opencodeCwd,
    stdio: ["pipe", "pipe", "inherit"],
  });
  await new Promise<void>((resolve, reject) => {
    proc.once("spawn", resolve);
    proc.once("error", reject);
  });

  const stream = ndJsonStream(
    Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>,
    Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>,
  );

  const toolCalls = new Map<string, ToolCallState>();
  const readIntervals = new Map<string, LineIntervals>();

  const recordRead = (chunk: ReadChunk) => {
    const target = normalizePath(chunk.path, sessionCwd);
    const total = countLines(target);
    const intervals = readIntervals.get(target) ?? [];
    if (chunk.limit == null) {
      addInterval(intervals, 0, total);
    } else {
      const start = chunk.offset != null && chunk.offset > 0 ? chunk.offset - 1 : 0;
      addInterval(intervals, start, Math.min(start + chunk.limit, total));
    }
    readIntervals.set(target, intervals);
  };

  const isReviewed = (target: string): boolean => {
    const total = countLines(target);
    if (total === 0) return readIntervals.has(target);
    const covered = coveredLines(readIntervals.get(target) ?? []);
    return covered * 100 >= total * minPct;
  };

  const app = client({ name: "deepreview" }).onNotification(
    "session/update",
    ({ params }) => {
      const update = params.update;
      onMessage(update);
      if (
        update.sessionUpdate === "tool_call" ||
        update.sessionUpdate === "tool_call_update"
      ) {
        const state = toolCalls.get(update.toolCallId) ?? { chunks: [] };
        if (update.kind) state.kind = update.kind;
        state.chunks.push(...extractReadChunks(update));
        toolCalls.set(update.toolCallId, state);
        if (state.kind === "read") {
          for (const c of state.chunks) recordRead(c);
          state.chunks = [];
        }
      }
    },
  );

  const targets = paths.map((p) => normalizePath(p, sessionCwd));

  try {
    return await app.connectWith(stream, async (agent) => {
      await agent.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "deepreview", version: "0.0.1" },
      });

      const { sessionId } = await agent.request("session/new", {
        cwd: sessionCwd,
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

      const mentions = extractMentionPaths(prompt.user, sessionCwd);
      const mentionBlocks = mentions.map(mentionToResource);
      for (const p of mentions) {
        const intervals = readIntervals.get(p) ?? [];
        addInterval(intervals, 0, countLines(p));
        readIntervals.set(p, intervals);
      }

      let nudges = 0;
      let stopReason: StopReason = "end_turn";

      while (true) {
        const remaining = targets.filter((t) => !isReviewed(t));
        const text =
          nudges === 0
            ? render(prompt.user, fileList)
            : render(prompt.nudge, remaining.join("\n"));

        const blocks: ContentBlock[] = [{ type: "text", text }];
        if (nudges === 0) blocks.push(...mentionBlocks);

        const res = await agent.request("session/prompt", {
          sessionId,
          prompt: blocks,
        });
        stopReason = res.stopReason;

        const unread = targets.filter((t) => !isReviewed(t));
        if (unread.length === 0 || nudges >= maxNudges) break;
        nudges += 1;
      }

      return {
        readPaths: targets.filter((t) => isReviewed(t)),
        unreadPaths: targets.filter((t) => !isReviewed(t)),
        stopReason,
        nudges,
      };
    });
  } finally {
    proc.kill();
  }
}
