import { deepReview } from "./deepreview.mts";

const dir = "/var/folders/6s/_ggmlvgs5yq8mnn7v9_d6gx00000gn/T/opencode/dr-test";

const result = await deepReview(
  { mode: "build" },
  {
    user: `Review both files briefly. Use the attached content of @${dir}/b.ts as-is, do NOT read b.ts with any tool. Read ${dir}/a.ts with the read tool.`,
    nudge: "Read this file now with the read tool:\n{{file_list}}",
  },
  [`${dir}/a.ts`, `${dir}/b.ts`],
  (update) => {
    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
      process.stdout.write(update.content.text);
    } else if (update.sessionUpdate === "tool_call") {
      console.log(`\n[tool_call] kind=${update.kind} title=${update.title}`);
    }
  },
  { maxNudges: 3 },
);

console.log("\n--- result ---");
console.log(JSON.stringify(result, null, 2));
