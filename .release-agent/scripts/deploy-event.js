const fs = require("fs");
const { loadState, saveState, isActive } = require("./lib/state");
const { loadApproversConfig } = require("./lib/config");
const { getMergedPRsForBranch } = require("./lib/github");
const { summarizeFailure } = require("./lib/ai");
const { postToSlack } = require("./lib/slack");
const { upsertGithubRelease } = require("./lib/github-release");

// Keeps the GitHub release page's status block current. Only applies once the
// release has been published (Release - Publish), and never blocks the deploy
// notification if GitHub hiccups.
async function refreshGithubRelease(state) {
  if (!state.github_release_id) return;
  try {
    await upsertGithubRelease(state);
  } catch (err) {
    console.error("GitHub release refresh failed (non-fatal):", err);
  }
}

/**
 * Tells the workflow to skip every remaining step. A refused deploy must not
 * fall through to the "deploy failed" step, which would mark the stage failed
 * and post a misleading failure summary.
 */
function markBlocked() {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, "blocked=true\n");
}

async function refuse(message) {
  console.error(message);
  markBlocked();
  try {
    await postToSlack(`:no_entry: ${message}`);
  } catch (err) {
    console.error("Couldn't post the refusal to Slack:", err);
  }
}

function checkStageOrder(state, environment) {
  const idx = state.stages.findIndex((s) => s.environment === environment);
  if (idx === -1) {
    return `"${environment}" isn't a configured environment for this release.`;
  }
  const incomplete = state.stages.slice(0, idx).find((s) => s.status !== "deployed");
  if (incomplete) {
    return `Can't deploy to ${environment} yet -- ${incomplete.environment} hasn't succeeded (currently: ${incomplete.status}).`;
  }
  return null;
}

function updateOverallStatus(state, environment, stageStatus) {
  if (stageStatus === "deploying") {
    state.status = `deploying (${environment})`;
  } else if (stageStatus === "failed") {
    state.status = `failed (${environment})`;
  } else if (stageStatus === "deployed") {
    const idx = state.stages.findIndex((s) => s.environment === environment);
    const isLastStage = idx === state.stages.length - 1;
    state.status = isLastStage ? "deployed" : `deployed to ${environment}`;
  }
}

async function main() {
  const eventType = process.argv[2]; // deploy_started | deploy_succeeded | deploy_failed
  const branch = process.argv[3];
  const environment = process.argv[4];
  const detail = process.argv[5] || "";

  if (!eventType || !branch || !environment) {
    console.error("Usage: node deploy-event.js <deploy_started|deploy_succeeded|deploy_failed> <branch> <environment> [detail]");
    process.exit(1);
  }

  const state = loadState(branch);

  // Problems found when a deploy *starts* are reported and the workflow's
  // remaining steps are skipped. Nothing is recorded as failed, because nothing
  // was attempted. Note the merge itself already happened in GitHub; this can
  // only flag it.
  if (eventType === "deploy_started") {
    if (!state) {
      await refuse(`A PR from \`${branch}\` merged into *${environment}*, but there's no release for that branch. Run Release - Cut first. Nothing was tracked.`);
      return;
    }
    if (!isActive(state)) {
      await refuse(`A PR from \`${branch}\` merged into *${environment}*, but that release is already ${state.status}. Nothing was tracked.`);
      return;
    }
    if (!state.stages.some((s) => s.environment === environment)) {
      await refuse(`*${environment}* isn't a configured stage for \`${branch}\`. Check environments.yaml. Nothing was tracked.`);
      return;
    }
    const blocker = checkStageOrder(state, environment);
    if (blocker) {
      await refuse(`${blocker} The merge into *${environment}* already happened in GitHub for \`${branch}\`, so this needs a person to look at it. Nothing was tracked.`);
      return;
    }
  }

  if (!state) {
    console.error(`No release found for branch "${branch}".`);
    process.exit(1);
  }

  const stage = state.stages.find((s) => s.environment === environment);
  if (!stage) {
    console.error(`"${environment}" is not a configured stage for this release.`);
    process.exit(1);
  }

  if (eventType === "deploy_started") {

    stage.status = "deploying";
    stage.started_at = new Date().toISOString();
    updateOverallStatus(state, environment, "deploying");
    saveState(branch, state);
    await refreshGithubRelease(state);

    let prCountText = "";
    try {
      const prs = await getMergedPRsForBranch(branch);
      prCountText = ` (${prs.length} PR${prs.length === 1 ? "" : "s"})`;
    } catch (err) {
      console.error("Failed to fetch PR count (non-fatal):", err);
    }

    const approvers = loadApproversConfig();
    const mentionIds = approvers[environment] || [];
    const mentionText = mentionIds.length > 0 ? `\ncc ${mentionIds.map((id) => `<@${id}>`).join(" ")}` : "";

    await postToSlack(`:hourglass_flowing_sand: *${environment}* deploy started for \`${branch}\`${prCountText}.${mentionText}`);
  } else if (eventType === "deploy_succeeded") {
    stage.status = "deployed";
    stage.completed_at = new Date().toISOString();
    updateOverallStatus(state, environment, "deployed");
    saveState(branch, state);
    await refreshGithubRelease(state);

    const isFullyDone = state.status === "deployed";
    await postToSlack(
      isFullyDone
        ? `:tada: *${environment}* deploy succeeded for \`${branch}\` -- that was the last stage, release complete!`
        : `:white_check_mark: *${environment}* deploy succeeded for \`${branch}\`. Next stage is ready when you are.`
    );
  } else if (eventType === "deploy_failed") {
    stage.status = "failed";
    stage.completed_at = new Date().toISOString();
    updateOverallStatus(state, environment, "failed");
    saveState(branch, state);
    await refreshGithubRelease(state);

    let summary = "No details provided.";
    if (detail) {
      try {
        summary = await summarizeFailure(detail);
      } catch (err) {
        console.error("summarizeFailure failed, falling back to raw detail:", err);
        summary = `(AI summary unavailable) ${String(detail).slice(0, 300)}`;
      }
    }

    await postToSlack([
      {
        type: "section",
        text: { type: "mrkdwn", text: `:rotating_light: *${environment} deploy issue detected for \`${branch}\`*\n${summary}` },
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `To roll back, run the *Release Rollback* workflow with branch \`${branch}\`.` }],
      },
    ], `Deploy failure for ${branch}`);
  } else {
    console.error(`Unknown event type "${eventType}"`);
    process.exit(1);
  }

  console.log(`Processed ${eventType} for "${branch}" / "${environment}".`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
