const { Octokit } = require("@octokit/rest");

function getOctokit() {
  return new Octokit({ auth: process.env.GITHUB_TOKEN });
}

function ownerRepo() {
  // GITHUB_REPOSITORY is set automatically by GitHub Actions on every
  // run, in the form "owner/repo" -- no need to configure this manually
  // the way GITHUB_OWNER/GITHUB_REPO env vars were needed in the old
  // always-on backend.
  const [owner, repo] = (process.env.GITHUB_REPOSITORY || "").split("/");
  if (!owner || !repo) {
    throw new Error("GITHUB_REPOSITORY is not set -- this must run inside a GitHub Actions job");
  }
  return { owner, repo };
}

async function getMergedPRsForBranch(branch) {
  const octokit = getOctokit();
  const { owner, repo } = ownerRepo();

  const { data: prs } = await octokit.pulls.list({
    owner,
    repo,
    state: "closed",
    base: branch,
    sort: "updated",
    direction: "desc",
    per_page: 50,
  });

  return prs
    .filter((pr) => pr.merged_at)
    .map((pr) => ({
      number: pr.number,
      title: pr.title,
      author: pr.user.login,
      labels: pr.labels.map((l) => l.name),
      url: pr.html_url,
      headRef: pr.head.ref,
    }))
    .sort((a, b) => a.number - b.number);
}

async function branchExists(branch) {
  const octokit = getOctokit();
  const { owner, repo } = ownerRepo();
  try {
    await octokit.repos.getBranch({ owner, repo, branch });
    return true;
  } catch (err) {
    if (err.status === 404) return false;
    throw err;
  }
}

module.exports = { getMergedPRsForBranch, branchExists, ownerRepo };
