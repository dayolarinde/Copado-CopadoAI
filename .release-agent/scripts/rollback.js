const { loadState, saveState } = require("./lib/state");
const { postToSlack } = require("./lib/slack");

async function main() {
  const branch = process.argv[2];
  const actor = process.argv[3] || "someone";

  if (!branch) {
    console.error("Usage: node rollback.js <branch> [actor]");
    process.exit(1);
  }

  const state = loadState(branch);
  if (!state) {
    console.error(`No release found for "${branch}".`);
    process.exit(1);
  }

  state.status = "rolled back";
  saveState(branch, state);

  // Note: there's no separate "confirm" click in this architecture --
  // manually running this workflow, with a named actor, IS the
  // deliberate confirmation. The always-on version's "Confirm rollback" /
  // "Cancel" buttons don't have an equivalent here; choosing not to run
  // this workflow is the equivalent of "Cancel."
  await postToSlack(
    `:warning: Rollback recorded for \`${branch}\` by ${actor}. Trigger your actual rollback pipeline now -- this only updates release-agent's tracked status.`
  );

  console.log(`Rollback recorded for "${branch}".`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
