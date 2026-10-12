# Release Agent — GitHub Actions version

The zero-server sibling of the artifact dashboard. No backend to host, no
database — just a workflow and one script.

## What it does

When a PR merges into `Genesysdev`, `SIT`, `PreProd`, or `Prod`, this:
1. Looks up which PRs have merged into that branch since the last time this
   workflow ran for it (tracked via a single git tag per branch — see the
   comments in the workflow file for how and why).
2. Asks Claude to draft short, Slack-formatted release notes from that PR list.
3. Posts the result straight to your Slack channel via an Incoming Webhook.

## Setup

1. Copy `.github/workflows/release-agent.yml`, `.github/scripts/release-notify.js`,
   and `.github/scripts/package.json` into your repo (same relative paths).
2. In Slack: add an **Incoming Webhook** to your release channel
   (api.slack.com/apps → your app → Incoming Webhooks → Add New Webhook to Workspace).
   Copy the webhook URL.
3. Generate a **fine-grained GitHub PAT with the account-level "Copilot Requests"
   permission** (Settings → Developer settings → Personal access tokens →
   Fine-grained tokens), on an account with an active Copilot subscription.
   This token needs *no* repository access — "Public Repositories (read-only)"
   is fine on the repository access step.
4. In your repo: **Settings → Secrets and variables → Actions**, add:
   - `SLACK_WEBHOOK_URL` — the webhook URL from step 2
   - `COPILOT_GITHUB_TOKEN` — the token from step 3
5. Make sure your repo actually has branches literally named `Genesysdev`,
   `SIT`, `PreProd`, and `Prod` — the trigger matches on exact branch name.
6. Merge a test PR into one of those branches and check the Slack channel.

**Why Copilot instead of a direct Claude/Anthropic API call:** if your org
hasn't yet approved a separate AI API for this kind of use, but already has
Copilot approved, routing through the Copilot SDK avoids a whole separate
approval process. The cost: every changelog draft now spins up a Copilot
CLI subprocess instead of firing one lightweight HTTP request, so this run
takes a bit longer and has one real npm dependency to install each time.
That's a deliberate trade of speed for organizational friction — the exact
same trade the Postgres-backed backend version made, for the same reason.

**Don't reuse `COPILOT_GITHUB_TOKEN` as anything else, and don't give it
repo access "just in case."** A token scoped only for Copilot Requests will
404 (not a clear auth error) if something tries to use it to read repo
data — keep it strictly separate from any token you use for GitHub API
reads elsewhere in your setup.

## How this compares to the other two versions

- **vs. the chat artifact:** this one needs zero manual data entry — it
  reacts to real merges automatically — but you lose the interactive
  board, the blocker-flagging, and the "draft on demand" control the
  artifact gives you. This posts on every merge; it doesn't wait for you
  to ask.
- **vs. a full Node/Express + Postgres backend:** this has nothing to host
  or pay for, but it also can't hold a multi-step approval checklist
  between runs, since there's no always-on process — GitHub Actions only
  exists for the few seconds it's running.

## Known limitation

If two PRs merge into the same branch within seconds of each other, both
workflow runs could read the marker tag before either has moved it, and
both would report the same PR list (a duplicate, not a missed one). For a
typical release-branch cadence this is unlikely to matter; if your team
merges into these branches very rapidly, the Postgres-backed version
removes this race by using real database transactions instead of a tag.

## Extending this

- To only post on an actual release cut (not every single merge), change
  the trigger to fire on tag pushes (`on: push: tags: ['v*']`) instead of
  `pull_request: closed`.
- To add an approval checklist, you'd need somewhere for state to live
  between "checklist posted" and "someone clicks a button" — which is
  exactly the problem the Postgres-backed backend solves. A workflow alone
  can't do this, because it doesn't stay running to receive that click.
