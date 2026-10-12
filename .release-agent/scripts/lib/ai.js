const { CopilotClient, approveAll } = require("@github/copilot-sdk");
const { loadReleaseNotesTemplate } = require("./config");

const MODEL = process.env.COPILOT_MODEL || "gpt-5";
const TIMEOUT_MS = Number(process.env.COPILOT_TIMEOUT_MS) || 60000;

/**
 * Unlike the always-on backend version of this file, there's no reason to
 * cache a client across calls here -- each GitHub Actions job run is
 * itself a fresh, short-lived process, so starting and stopping the
 * client once per script invocation is the natural fit, not a
 * performance concern the way it would be for a persistent server
 * handling many requests.
 */
async function runPrompt(prompt, timeoutMs = TIMEOUT_MS) {
  const client = new CopilotClient({ gitHubToken: process.env.COPILOT_GITHUB_TOKEN });
  await client.start();

  try {
    const session = await client.createSession({ model: MODEL, onPermissionRequest: approveAll });
    try {
      const response = await session.sendAndWait({ prompt }, timeoutMs);
      if (!response) {
        throw new Error("Copilot session completed with no assistant message");
      }
      return response.data.content.trim();
    } finally {
      await session.disconnect().catch(() => {});
    }
  } finally {
    await client.stop().catch(() => {});
  }
}

async function draftChangelog(prs) {
  if (prs.length === 0) {
    return "_No merged PRs found for this branch._";
  }

  const prList = prs
    .map((pr) => `- #${pr.number} ${pr.title} (${pr.author}) [labels: ${pr.labels.join(", ") || "none"}]`)
    .join("\n");

  const template = loadReleaseNotesTemplate();
  const sectionList = template.sections.map((s) => `- "${s.name}": ${s.description}`).join("\n");

  const prompt = `You are drafting release notes for a software release. Given this list of merged pull requests, sort each one into exactly one of the following sections, based on its title and labels:

${sectionList}

Use these exact section names as markdown headers, in this exact order. Skip a section entirely (no header at all) if no PRs fit it -- don't show an empty section.

Write like a person summarizing what changed to a colleague, not like a bulleted changelog generator -- natural, plain sentences. Still keep it concise -- one clear sentence per item is usually enough.

Output ONLY the release notes content itself -- no preamble, no meta-commentary about the PRs' quality or naming, no suggestions for how to improve future PRs, and no questions back to the reader. This text gets posted directly to Slack.

Pull requests:
${prList}`;

  return runPrompt(prompt);
}

async function summarizeFailure(logExcerpt) {
  const prompt = `Summarize this CI/deploy failure log in 2-3 plain-English sentences for a Slack message aimed at a release manager who isn't deep in the logs. Focus on what failed and the likely cause if apparent. Do not include the raw log.

Output ONLY the summary itself -- no preamble, no questions back to the reader.

Log:
${logExcerpt}`;

  return runPrompt(prompt);
}

module.exports = { draftChangelog, summarizeFailure };
