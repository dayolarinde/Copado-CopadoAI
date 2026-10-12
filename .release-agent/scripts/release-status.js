const { loadState, isActive, listAllStates } = require("./lib/state");
const { getMergedPRsForBranch } = require("./lib/github");
const { postToSlack } = require("./lib/slack");

const STAGE_ICONS = { pending: "⬜", deploying: "⏳", deployed: "✅", failed: "🔴" };

function formatSummary(state) {
  const done = state.checklist.filter((i) => i.done).length;
  const stageLine = state.stages.length
    ? state.stages.map((s) => `${STAGE_ICONS[s.status] || "⬜"} ${s.environment}`).join("  →  ")
    : "_(no environment stages configured)_";

  const started = state.stages.filter((s) => s.started_at);
  let lastMerge = "Last merge: none yet";
  if (started.length > 0) {
    const latest = started.reduce((a, b) => (new Date(a.started_at) > new Date(b.started_at) ? a : b));
    const when = new Date(latest.started_at).toISOString().slice(0, 16).replace("T", " ");
    lastMerge = `Last merge: \`${latest.environment}\` at ${when} UTC`;
  }

  return `*Release for \`${state.branch}\`* — status: *${state.status}*\nChecklist: ${done}/${state.checklist.length} complete\nStages: ${stageLine}\n${lastMerge}`;
}

async function main() {
  const branch = process.argv[2];

  if (!branch) {
    const active = listAllStates().filter(isActive);
    if (active.length === 0) {
      await postToSlack("No releases currently in progress.");
      return;
    }
    await postToSlack(active.map(formatSummary).join("\n\n"));
    return;
  }

  const state = loadState(branch);
  if (!state) {
    await postToSlack(`No release found for \`${branch}\`.`);
    return;
  }

  let prSection;
  try {
    const prs = await getMergedPRsForBranch(branch);
    prSection =
      prs.length === 0
        ? "*Merged PRs:* none yet"
        : `*Merged PRs (${prs.length}):*\n` +
          prs.map((pr) => `• <${pr.url}|#${pr.number}> ${pr.title} (${pr.author})`).join("\n");
  } catch (err) {
    console.error("Failed to fetch merged PRs:", err);
    prSection = "_(Couldn't fetch the merged PR list right now)_";
  }

  const checklistText = state.checklist.map((i) => `${i.done ? "✅" : "⬜"} ${i.label}`).join("\n");

  await postToSlack(
    [
      { type: "section", text: { type: "mrkdwn", text: formatSummary(state) } },
      { type: "divider" },
      { type: "section", text: { type: "mrkdwn", text: prSection } },
      { type: "divider" },
      { type: "section", text: { type: "mrkdwn", text: `*Approval checklist*\n${checklistText}` } },
    ],
    `Status for ${branch}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
