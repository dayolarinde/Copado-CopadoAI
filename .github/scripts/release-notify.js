// Runs inside the GitHub Actions job. GitHub API + Slack calls use Node
// 20's built-in fetch (no dependency needed). The changelog draft goes
// through the GitHub Copilot SDK instead of a plain API call -- same
// reason as the Postgres-backed backend: it avoids needing separate
// approval for a new AI API if your org has already approved Copilot.
// That does mean this script now has one real dependency (see the
// package.json alongside this file) instead of zero.

const { CopilotClient, approveAll } = require("@github/copilot-sdk");

const {
  GITHUB_TOKEN,
  REPO,
  BASE_BRANCH,
  HEAD_BRANCH,
  PR_NUMBER,
  PR_TITLE,
  PR_AUTHOR,
  SLACK_WEBHOOK_URL,
  COPILOT_GITHUB_TOKEN,
  COPILOT_MODEL,
} = process.env;

const MODEL = COPILOT_MODEL || "gpt-5";

const [owner, repo] = REPO.split("/");
const MARKER_TAG = `release-agent-marker-${BASE_BRANCH}`;

async function ghFetch(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "release-agent-workflow",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/**
 * Finds when this branch's marker tag last pointed to, so we know how far
 * back to look for "new" merged PRs. Returns null on the very first run
 * for a branch (no tag exists yet) -- in that case every currently-merged
 * PR into the branch is treated as "new."
 */
async function getMarkerDate() {
  try {
    const ref = await ghFetch(`/repos/${owner}/${repo}/git/refs/tags/${MARKER_TAG}`);
    const commit = await ghFetch(`/repos/${owner}/${repo}/commits/${ref.object.sha}`);
    return commit.commit.committer.date;
  } catch (err) {
    return null;
  }
}

async function getMergedPRsSince(sinceDate) {
  const prs = await ghFetch(
    `/repos/${owner}/${repo}/pulls?state=closed&base=${encodeURIComponent(BASE_BRANCH)}&sort=updated&direction=desc&per_page=50`
  );
  return prs.filter((pr) => {
    if (!pr.merged_at) return false;
    if (!sinceDate) return true;
    return new Date(pr.merged_at) > new Date(sinceDate);
  });
}

/**
 * Sends one prompt to Copilot and returns the assembled text response.
 * Unlike an always-on backend (which would keep one client alive for the
 * whole process lifetime), this workflow only ever needs one prompt per
 * run -- so it starts a client, runs the one prompt, and shuts it down
 * again within this single function.
 */
async function runCopilotPrompt(prompt, timeoutMs = 30000) {
  const client = new CopilotClient({
    // Passing the token directly (rather than an interactive browser
    // login) is what makes this work headless on a GitHub-hosted runner.
    gitHubToken: COPILOT_GITHUB_TOKEN,
  });

  // Node's EventEmitter crashes the whole process if an 'error' event
  // fires with no listener attached. Without this, a Copilot CLI
  // subprocess hiccup would fail this entire Actions job with a
  // confusing, unrelated-looking crash instead of a clear error message.
  client.on("error", (err) => {
    console.error("CopilotClient emitted an error (subprocess-level):", err);
  });

  await client.start();

  try {
    const session = await client.createSession({ model: MODEL, onPermissionRequest: approveAll });

    let output = "";
    let settled = false;

    const done = new Promise((resolve, reject) => {
      session.on("assistant.message", (event) => {
        output += event.data.content;
      });
      session.on("session.idle", () => {
        settled = true;
        resolve();
      });
      session.on("error", (err) => {
        settled = true;
        reject(err);
      });
    });

    const timeout = new Promise((_, reject) => {
      setTimeout(() => {
        if (!settled) reject(new Error(`Copilot session timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    await session.send({ prompt });
    await Promise.race([done, timeout]);
    await session.disconnect().catch(() => {});

    return output.trim();
  } finally {
    await client.stop().catch(() => {});
  }
}

async function draftChangelog(prs) {
  if (prs.length === 0) {
    // Shouldn't normally happen (the PR that triggered this run is always
    // merged), but a safe fallback if the GitHub API call above comes back
    // empty for any reason.
    return `_No merged PR details available -- see PR #${PR_NUMBER} directly._`;
  }

  const prList = prs
    .map(
      (pr) =>
        `- #${pr.number} ${pr.title} (${pr.user.login}) [labels: ${pr.labels.map((l) => l.name).join(", ") || "none"}]`
    )
    .join("\n");

  const prompt = `Draft short release notes for a Slack message. Group these merged pull requests into Features, Fixes, and Chores if there's a natural split, otherwise a flat bullet list. One line per PR, plain professional tone, use Slack mrkdwn (*bold*, not markdown **bold**). No preamble or sign-off, just the notes.

Pull requests merged into ${BASE_BRANCH}:
${prList}`;

  try {
    return await runCopilotPrompt(prompt);
  } catch (err) {
    // A drafting failure shouldn't mean the team hears nothing -- fall
    // back to the raw PR list rather than letting the whole run fail.
    console.error("Copilot drafting failed, falling back to raw PR list:", err);
    return prList;
  }
}

async function postSlack(text) {
  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    throw new Error(`Slack webhook failed: ${res.status} ${await res.text()}`);
  }
}

(async () => {
  const sinceDate = await getMarkerDate();
  const prs = await getMergedPRsSince(sinceDate);
  const changelog = await draftChangelog(prs);

  const header = `:rocket: *${BASE_BRANCH}* received a merge from \`${HEAD_BRANCH}\` — PR #${PR_NUMBER} by ${PR_AUTHOR}: "${PR_TITLE}"`;
  await postSlack(`${header}\n\n${changelog}`);

  console.log(`Posted update to Slack for ${BASE_BRANCH} (${prs.length} PR(s) included).`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
