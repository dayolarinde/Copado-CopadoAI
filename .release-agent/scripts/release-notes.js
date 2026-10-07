const fs = require("fs");
const path = require("path");
const { loadState, saveState, slugify } = require("./lib/state");
const { getMergedPRsForBranch } = require("./lib/github");
const { draftChangelog } = require("./lib/ai");
const { buildReleaseNotesDocx } = require("./lib/release-notes-docx");
const { postToSlack } = require("./lib/slack");

async function main() {
  const branch = process.argv[2];
  if (!branch) {
    console.error("Usage: node release-notes.js <branch>");
    process.exit(1);
  }

  const state = loadState(branch);
  if (!state) {
    console.error(`No release found for "${branch}".`);
    process.exit(1);
  }

  const prs = await getMergedPRsForBranch(branch);
  const changelog = await draftChangelog(prs);
  state.changelog = changelog;
  saveState(branch, state);

  const docxDir = path.join(process.cwd(), ".release-agent", "release-notes");
  fs.mkdirSync(docxDir, { recursive: true });
  const fileName = `${slugify(branch)}.docx`;
  const docxPath = path.join(docxDir, fileName);
  const buffer = await buildReleaseNotesDocx(branch, changelog);
  fs.writeFileSync(docxPath, buffer);

  const repo = process.env.GITHUB_REPOSITORY;
  const defaultBranch = process.env.GITHUB_DEFAULT_BRANCH || "main";
  const docLink = repo
    ? `https://github.com/${repo}/blob/${defaultBranch}/.release-agent/release-notes/${fileName}`
    : null;

  const blocks = [
    { type: "section", text: { type: "mrkdwn", text: `*:arrows_counterclockwise: Release notes refreshed for \`${branch}\`*` } },
    { type: "divider" },
    { type: "section", text: { type: "mrkdwn", text: changelog.slice(0, 2900) } },
  ];

  if (docLink) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `<${docLink}|Download Word doc>` } });
  }

  await postToSlack(blocks, `Release notes refreshed for ${branch}`);

  console.log(`Release notes refreshed for "${branch}". Word doc written to ${docxPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
