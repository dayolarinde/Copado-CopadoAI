# Release Agent — Zero-Hosting Edition

A release management tool that automates drafting release notes, running approval checklists, and
tracking deploys across SIT/UAT/PROD — with **no server, no database, and no third-party hosting
platform**. Everything runs inside GitHub Actions and lives in this repo.

## How this differs from a normal Slack bot

There's no always-on backend here. Instead:

| Piece | How it works here |
|---|---|
| Starting a release, checking status, etc. | You manually run a GitHub Actions workflow (via the Actions tab), instead of typing a Slack slash command |
| Checklist items | Checked off by running a workflow with the item's ID, instead of clicking a button |
| Notifications | Sent via a Slack **Incoming Webhook** (a plain URL you POST to) — not a bot with a token |
| State (releases, checklists, deploy stages) | Stored as JSON files directly in this repo, under `.release-agent/releases/`, committed by the workflows themselves |
| AI drafting (release notes, failure summaries) | Runs the GitHub Copilot SDK as a one-off script inside each workflow run, not a persistent process |

The tradeoff: no clickable buttons, no instant (<3 second) responses, and everything happens through
GitHub's UI instead of Slack's. In exchange: nothing to host, nothing to pay for, no third-party
platform for a security team to review.

## Setup

### 1. Create a Slack Incoming Webhook
1. Go to **api.slack.com/apps** → your app (or create a new one) → **Incoming Webhooks** → toggle on
2. **Add New Webhook to Workspace** → pick the channel you want release updates posted to
3. Copy the webhook URL it gives you (looks like `https://hooks.slack.com/services/...`)

This is simpler than the old setup — no bot token, no OAuth scopes, no Bolt app, no Slack app
installation beyond enabling this one feature.

### 2. Get a GitHub token for Copilot
Same as before: a fine-grained personal access token from an account with an active Copilot
subscription, with the **Copilot Requests** account permission enabled (under Account permissions,
not Repository permissions). Classic tokens are not supported for this.

### 3. Add repo secrets
Settings → Secrets and variables → Actions → add:
- `SLACK_WEBHOOK_URL` — from step 1
- `COPILOT_GITHUB_TOKEN` — from step 2

To use **Release - Publish** (Jira + GitHub release page), also add:
- `JIRA_BASE_URL` — e.g. `https://yourcompany.atlassian.net`
- `JIRA_EMAIL` — the Atlassian account the token belongs to
- `JIRA_API_TOKEN` — created at id.atlassian.com (these expire, so put a rotation date on your calendar)
- `JIRA_PROJECT_KEY` — e.g. `PROJ`, the project that owns the release version

You do **not** need a separate `GITHUB_TOKEN` secret — Actions provides one automatically to every
workflow run, scoped to this repo, which is sufficient for reading PRs and committing state files.

### 4. Create the SIT/UAT/PROD branches
If they don't already exist, create branches literally named `SIT`, `UAT`, and `PROD` in this repo —
the `Deploy` workflow triggers on pull requests merging into these specific names.

### 5. Create a `simulate-failure` label
Issues/PRs tab → Labels → New label, named `simulate-failure`. Used for testing the failure path
without needing a real deploy failure.

### 6. Confirm branch protection allows this
The `Deploy` workflow commits directly to your default branch mid-run (to record deploy status). If
your default branch has protection rules blocking direct pushes — even from Actions — these commits
will fail. Either allow the `github-actions` bot to bypass protection for this specific need, or check
with whoever administers branch protection on how they'd like this handled.

## Usage

All of these are run from the **Actions** tab → select the workflow → **Run workflow**.

- **Release - Cut** — start a new release. Input: `branch` (the release branch name).
- **Release - Checklist** — mark a checklist item done. Inputs: `branch`, `item_id` (see
  `config/checklist.yaml` for valid IDs).
- **Release - Status** — post a release's status to Slack. Input: `branch` (leave empty to list every
  active release).
- **Release - Notes** — regenerate release notes and get a Word doc copy, committed into
  `.release-agent/release-notes/`. Input: `branch`.
- **Release - Publish** — publish a release to Jira and GitHub. Input: `branch`. Creates (or updates) a
  release page on GitHub and a release version in Jira named after the branch, puts the notes in the
  Jira version's description, and sets Fix Version on every ticket whose key appears in a merged PR's
  branch name (falling back to the PR title). Jira's own Release notes page then lists those tickets by
  issue type. Re-run it after more PRs merge. The GitHub page's status block is kept current by the
  Deploy workflow afterward, and the release stays marked pre-release until the last stage succeeds.
- **Release - Rollback** — record a rollback. Input: `branch`. Running this workflow *is* the
  confirmation — there's no separate confirm/cancel step. This only updates tracked status; it does
  not trigger an actual rollback of your code.
- **Deploy** — triggers automatically when a PR merges into `SIT`, `UAT`, or `PROD`. No manual step
  unless you're testing (add the `simulate-failure` label to test the failure path). If a merge can't be
  tracked (out of order, no release for that branch, or the release is already finished), Slack gets a
  note explaining why and nothing is recorded as failed. The merge itself has already happened in GitHub
  by then, so this can only flag it.

## Customizing

Same config files as before, all under `.release-agent/config/`:
- `checklist.yaml` — approval checklist items
- `environments.yaml` — ordered environment stages
- `approvers.yaml` — who gets @-mentioned per stage
- `release-notes-template.yaml` — release notes section names/order/footer

Edit any of these directly — no code changes needed, no redeploy step (there's nothing to redeploy;
the next workflow run just reads the updated file).

## Known limitations of this architecture

- **No clickable buttons.** Every action is "run a workflow," not "click a thing in Slack."
- **Not instant.** GitHub Actions jobs take some seconds to start and run — expect delays of 10-60+
  seconds between triggering something and seeing the Slack message, not the sub-second response a
  live bot gives.
- **State is git-committed JSON, not a real database.** Two workflows racing to update the same
  release's state file at the same moment could hit a git push conflict. Each workflow does a
  `git pull --rebase` before pushing to reduce this, but it's not a full guarantee the way a database
  transaction is. Low risk for a small team's actual usage pattern, worth knowing about.
- **Rollback only tracks status.** Same as the always-on version — it records that a rollback happened,
  it doesn't trigger one.
- **The `Deploy` workflow assumes promotion happens via merged PRs**, not direct pushes to SIT/UAT/PROD.
  If your real process pushes directly, this trigger won't fire — let's revisit if that's the case.

## Publishing notes: what to know

- **Jira permissions.** Creating a release version needs *Administer Projects* on that Jira project (or
  Jira admin) for the account behind the API token. Setting Fix Version on tickets also needs permission
  to edit those tickets, and the Fix Version field has to be on the ticket's screen — a ticket that
  fails either check is reported in Slack and skipped, and the rest still get tagged.
- **Ticket matching.** Only keys for the configured `JIRA_PROJECT_KEY` count, so a branch like
  `feature/add-widget-2` isn't mistaken for a ticket. If one branch carries two keys, only the first is
  used. PRs with no key are listed in the Slack summary.
- **Jira description length.** Version descriptions are plain text. If Jira turns down the full notes as
  too long, the description falls back to a link to the GitHub release, and the Slack message says so.
- **Tag protection.** Publishing creates a tag named `rel-<branch>` on first run. If your repo has tag
  rules that block tag creation by Actions, the publish step will fail at the GitHub release.
