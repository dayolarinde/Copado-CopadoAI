const { loadState, saveState, isActive } = require("./lib/state");
const { loadChecklistConfig, loadEnvironmentConfig } = require("./lib/config");
const { getMergedPRsForBranch, branchExists } = require("./lib/github");
const { draftChangelog } = require("./lib/ai");
const { postToSlack } = require("./lib/slack");

async function main() {
  const branch = process.argv[2];
  if (!branch) {
    console.error("Usage: node cut-release.js <branch>");
    process.exit(1);
  }

  const existing = loadState(branch);
  if (isActive(existing)) {
    console.error(
      `Branch "${branch}" already has an active release (status: ${existing.status}). ` +
        `Check its status, or wait until it's deployed/rolled back before cutting a new one.`
    );
    process.exit(1);
  }

  const exists = await branchExists(branch);
  if (!exists) {
    console.error(`Branch "${branch}" doesn't exist in this repo. Double-check the name.`);
    process.exit(1);
  }

  const prs = await getMergedPRsForBranch(branch);
  const changelog = await draftChangelog(prs);

  const checklistConfig = loadChecklistConfig();
  const checklistItems = (checklistConfig.default || []).map((item) => ({
    id: item.id,
    label: item.label,
    done: false,
    done_by: null,
  }));

  const stageNames = loadEnvironmentConfig();
  const stages = stageNames.map((name) => ({
    environment: name,
    status: "pending",
    started_at: null,
    completed_at: null,
  }));

  const state = {
    branch,
    status: "pending approvals",
    changelog,
    checklist: checklistItems,
    stages,
    created_at: new Date().toISOString(),
  };

  saveState(branch, state);

  const checklistText = checklistItems.map((i) => `⬜ ${i.label}`).join("\n");

  await postToSlack(
    [
      { type: "section", text: { type: "mrkdwn", text: `*:rocket: New release draft — \`${branch}\`*` } },
      { type: "divider" },
      { type: "section", text: { type: "mrkdwn", text: changelog.slice(0, 2900) } },
      { type: "divider" },
      { type: "section", text: { type: "mrkdwn", text: `*Approval checklist*\n${checklistText}` } },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `To check off an item, run the *Release Checklist* workflow with branch \`${branch}\`.`,
          },
        ],
      },
    ],
    `New release cut for ${branch}`
  );

  console.log(`Release cut for "${branch}". State saved.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
