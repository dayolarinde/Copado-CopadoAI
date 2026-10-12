const { loadState, saveState } = require("./lib/state");
const { getMergedPRsForBranch } = require("./lib/github");
const { upsertGithubRelease } = require("./lib/github-release");
const jira = require("./lib/jira");
const { postToSlack } = require("./lib/slack");

// Jira's version description is plain text; keep it well under the 32,767
// character ceiling that applies to Jira's long text fields.
const MAX_DESCRIPTION = 30000;

async function main() {
  const branch = process.argv[2];
  if (!branch) {
    console.error("Usage: node publish-release.js <branch>");
    process.exit(1);
  }

  const state = loadState(branch);
  if (!state) {
    console.error(`No release found for "${branch}". Run Release - Cut first.`);
    process.exit(1);
  }

  const { projectKey } = jira.config();
  const prs = await getMergedPRsForBranch(branch);

  // 1. GitHub release page first. Its link goes into the Jira description, so
  //    Jira readers can reach the full notes even if the text there is cut short.
  const ghRelease = await upsertGithubRelease(state);
  state.github_release_id = ghRelease.id;
  state.github_release_url = ghRelease.url;

  // 2. Work out which Jira tickets are in this release. The ticket key lives in
  //    the feature branch name, so that's checked first, then the PR title.
  const tickets = new Map(); // key -> PR numbers
  const noKey = [];
  for (const pr of prs) {
    const key = jira.extractTicketKey(pr.headRef, projectKey) || jira.extractTicketKey(pr.title, projectKey);
    if (!key) {
      noKey.push(pr.number);
      continue;
    }
    if (!tickets.has(key)) tickets.set(key, []);
    tickets.get(key).push(pr.number);
  }

  // 3. Create (or update) the Jira release version with the notes.
  const header = `Full notes and status: ${ghRelease.url}\n\n`;
  let description = header + jira.markdownToPlainText(state.changelog);
  if (description.length > MAX_DESCRIPTION) description = description.slice(0, MAX_DESCRIPTION - 1) + "…";
  const shortDescription = `Full release notes: ${ghRelease.url}`.slice(0, 250);

  const { version, usedShortDescription, created } = await jira.upsertVersion(projectKey, branch, description, shortDescription);

  // 4. Set Fix Version on each ticket. One bad ticket shouldn't stop the rest.
  const tagged = [];
  const failed = [];
  for (const key of tickets.keys()) {
    try {
      const issue = await jira.getIssue(key);
      if (!issue) {
        failed.push({ key, reason: "ticket not found in Jira" });
        continue;
      }
      await jira.addFixVersion(key, branch);
      tagged.push(key);
    } catch (err) {
      failed.push({ key, reason: err.message });
    }
  }

  state.jira_version_id = version.id;
  state.jira_version_url = jira.versionUrl(projectKey, version.id);
  state.jira_tickets = tagged;
  state.published_at = new Date().toISOString();

  // Refresh the GitHub page now that it can link to the Jira version.
  await upsertGithubRelease(state);
  saveState(branch, state);

  const lines = [
    `*:package: Published \`${branch}\`*`,
    `<${state.github_release_url}|GitHub release>  •  <${state.jira_version_url}|Jira release>${created ? " (created)" : " (updated)"}`,
    `Fix Version set on ${tagged.length} ticket${tagged.length === 1 ? "" : "s"}: ${tagged.join(", ") || "none"}`,
  ];
  if (noKey.length) lines.push(`No ${projectKey} ticket key found for PR${noKey.length === 1 ? "" : "s"} ${noKey.map((n) => `#${n}`).join(", ")}`);
  if (failed.length) lines.push(`:warning: Couldn't tag: ${failed.map((f) => `${f.key} (${f.reason})`).join("; ")}`);
  if (usedShortDescription) lines.push("_Jira rejected the full notes as too long, so its description holds a link to the GitHub release instead._");

  await postToSlack(lines.join("\n"));
  console.log(lines.join("\n"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
