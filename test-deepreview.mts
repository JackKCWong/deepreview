import { deepReview } from "./deepreview.mts";

const dir = "/var/folders/6s/_ggmlvgs5yq8mnn7v9_d6gx00000gn/T/opencode/dr-test";

const result = await deepReview(
  { mode: "build" },
  `Review only this one file briefly: ${dir}/a.ts. Do not read any other file.`,
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
