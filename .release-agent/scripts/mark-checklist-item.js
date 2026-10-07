const { loadState, saveState } = require("./lib/state");
const { postToSlack } = require("./lib/slack");

async function main() {
  const branch = process.argv[2];
  const itemId = process.argv[3];
  const doneBy = process.argv[4] || "someone";

  if (!branch || !itemId) {
    console.error("Usage: node mark-checklist-item.js <branch> <item-id> [done-by]");
    process.exit(1);
  }

  const state = loadState(branch);
  if (!state) {
    console.error(`No release found for branch "${branch}".`);
    process.exit(1);
  }

  const item = state.checklist.find((i) => i.id === itemId);
  if (!item) {
    const validIds = state.checklist.map((i) => i.id).join(", ");
    console.error(`No checklist item "${itemId}" found. Valid item IDs for this release: ${validIds}`);
    process.exit(1);
  }

  item.done = true;
  item.done_by = doneBy;

  const allDone = state.checklist.every((i) => i.done);
  if (allDone) {
    state.status = "ready to deploy";
  }

  saveState(branch, state);

  const checklistText = state.checklist
    .map((i) => `${i.done ? "✅" : "⬜"} ${i.label}${i.done ? ` _(by ${i.done_by})_` : ""}`)
    .join("\n");

  await postToSlack(
    [{ type: "section", text: { type: "mrkdwn", text: `*Checklist updated for \`${branch}\`*\n${checklistText}` } }],
    `Checklist updated for ${branch}`
  );

  if (allDone) {
    await postToSlack(`:white_check_mark: All checklist items complete for \`${branch}\`. Ready to deploy.`);
  }

  console.log(`Marked "${itemId}" done for "${branch}".`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
