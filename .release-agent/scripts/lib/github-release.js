const { getOctokit, ownerRepo } = require("./github");
const { slugify } = require("./state");

const STAGE_ICONS = { pending: "⬜", deploying: "⏳", deployed: "✅", failed: "🔴" };

/**
 * One tag per release branch. The "rel-" prefix keeps it from ever matching a
 * branch name (a tag and branch sharing a name makes plain git commands
 * ambiguous), and it has no slash so it's safe in API paths.
 */
function tagFor(branch) {
  return `rel-${slugify(branch)}`;
}

/** The release page body: the notes, then a status block that gets refreshed as the release moves. */
function buildReleaseBody(state) {
  const done = state.checklist.filter((i) => i.done).length;
  const stageLine = state.stages.length
    ? state.stages.map((s) => `${STAGE_ICONS[s.status] || "⬜"} ${s.environment}`).join(" → ")
    : "no environment stages configured";

  const lines = [state.changelog || "_No release notes yet._", "", "---", "", `**Status:** ${state.status}`, `**Stages:** ${stageLine}`, `**Checklist:** ${done}/${state.checklist.length} complete`];

  if (state.jira_version_url) {
    const count = (state.jira_tickets || []).length;
    lines.push(`**Jira:** [release in Jira](${state.jira_version_url}) (${count} ticket${count === 1 ? "" : "s"})`);
  }

  lines.push("", `_Last updated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC_`);
  return lines.join("\n");
}

/**
 * Creates the release page the first time, then updates the same one afterward.
 * It stays marked pre-release until the last environment stage succeeds.
 */
async function upsertGithubRelease(state) {
  const octokit = getOctokit();
  const { owner, repo } = ownerRepo();
  const tag = tagFor(state.branch);
  const body = buildReleaseBody(state);
  const prerelease = state.status !== "deployed";

  let releaseId = state.github_release_id;

  if (!releaseId) {
    try {
      const { data } = await octokit.repos.getReleaseByTag({ owner, repo, tag });
      releaseId = data.id;
    } catch (err) {
      if (err.status !== 404) throw err;
    }
  }

  if (releaseId) {
    const { data } = await octokit.repos.updateRelease({
      owner,
      repo,
      release_id: releaseId,
      name: state.branch,
      body,
      prerelease,
    });
    return { id: data.id, url: data.html_url, tag };
  }

  const { data } = await octokit.repos.createRelease({
    owner,
    repo,
    tag_name: tag,
    target_commitish: state.branch,
    name: state.branch,
    body,
    prerelease,
  });
  return { id: data.id, url: data.html_url, tag };
}

module.exports = { tagFor, buildReleaseBody, upsertGithubRelease };
