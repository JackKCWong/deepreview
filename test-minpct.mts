import { deepReview } from "./deepreview.mts";

const dir = "/var/folders/6s/_ggmlvgs5yq8mnn7v9_d6gx00000gn/T/opencode/dr-test";

const result = await deepReview(
  { mode: "build" },
  {
    user: `Read only the first 10 lines of ${dir}/big.ts (use the read tool with limit=10) and tell me what you saw. Do not read more than 10 lines.`,
    nudge:
      "These files have not been fully read yet. Read the remaining unread lines of each with the read tool:\n{{file_list}}",
  },
  [`${dir}/big.ts`],
  (update) => {
    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
      process.stdout.write(update.content.text);
    } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      console.log(`\n[${update.sessionUpdate}] ${JSON.stringify(update)}`);
    }
  },
  { maxNudges: 3, minPct: 90 },
);

console.log("\n--- result ---");
console.log(JSON.stringify(result, null, 2));
