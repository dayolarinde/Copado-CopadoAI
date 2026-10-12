const http = require("http");
const https = require("https");

/**
 * Minimal Jira Cloud REST client using API token + email (HTTP Basic).
 * Needs these env vars, set as GitHub repo secrets:
 *   JIRA_BASE_URL     e.g. https://yourcompany.atlassian.net
 *   JIRA_EMAIL        the account the API token belongs to
 *   JIRA_API_TOKEN    created at id.atlassian.com (these expire, so plan to rotate)
 *   JIRA_PROJECT_KEY  e.g. PROJ -- the project whose release version gets created
 */

function config() {
  const baseUrl = (process.env.JIRA_BASE_URL || "").replace(/\/+$/, "");
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  const projectKey = (process.env.JIRA_PROJECT_KEY || "").toUpperCase();
  const missing = [
    ["JIRA_BASE_URL", baseUrl],
    ["JIRA_EMAIL", email],
    ["JIRA_API_TOKEN", token],
    ["JIRA_PROJECT_KEY", projectKey],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    throw new Error(`Missing Jira settings: ${missing.join(", ")}. Add them as repo secrets.`);
  }
  return { baseUrl, email, token, projectKey };
}

class JiraError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

function request(method, path, body) {
  const { baseUrl, email, token } = config();
  const url = new URL(baseUrl + path);
  const transport = url.protocol === "http:" ? http : https; // http only for local test servers
  const payload = body === undefined ? null : JSON.stringify(body);

  const headers = {
    Accept: "application/json",
    Authorization: "Basic " + Buffer.from(`${email}:${token}`).toString("base64"),
  };
  if (payload) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = Buffer.byteLength(payload);
  }

  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || undefined,
        path: url.pathname + url.search,
        method,
        headers,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let parsed = null;
          if (data) {
            try {
              parsed = JSON.parse(data);
            } catch {
              parsed = data;
            }
          }
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed);
          const detail =
            parsed && typeof parsed === "object"
              ? [...(parsed.errorMessages || []), ...Object.values(parsed.errors || {})].join("; ")
              : String(parsed || "");
          reject(new JiraError(`Jira ${method} ${path} failed (${res.statusCode}): ${detail}`, res.statusCode, parsed));
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Pulls a ticket key like PROJ-123 out of a string (branch name or PR title),
 * but only if it belongs to the configured project. Requiring the known project
 * prefix avoids false hits such as "widget-2" in "feature/add-widget-2".
 */
function extractTicketKey(text, projectKey) {
  if (!text || !projectKey) return null;
  const escaped = projectKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:^|[^A-Za-z0-9])(${escaped}-\\d+)(?![0-9])`, "i");
  const match = String(text).match(pattern);
  return match ? match[1].toUpperCase() : null;
}

async function getIssue(key) {
  try {
    return await request("GET", `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,issuetype`);
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

async function findVersion(projectKey, name) {
  const versions = await request("GET", `/rest/api/3/project/${encodeURIComponent(projectKey)}/versions`);
  return (Array.isArray(versions) ? versions : []).find((v) => v.name === name) || null;
}

function isDescriptionTooLong(err) {
  return err.status === 400 && /description/i.test(JSON.stringify(err.body || ""));
}

/**
 * Creates the version, or updates its description if it already exists.
 *
 * Version descriptions are plain text. I couldn't confirm the length limit for
 * this specific field in Jira's docs (long text fields cap at 32,767, short
 * ones at 255), so if Jira rejects the full text this retries with
 * `shortDescription`, which should hold a link to the full notes instead.
 */
async function upsertVersion(projectKey, name, description, shortDescription) {
  const existing = await findVersion(projectKey, name);

  const send = async (text) =>
    existing
      ? request("PUT", `/rest/api/3/version/${existing.id}`, { description: text })
      : request("POST", "/rest/api/3/version", { name, project: projectKey, description: text, released: false });

  try {
    return { version: await send(description), usedShortDescription: false, created: !existing };
  } catch (err) {
    if (!isDescriptionTooLong(err) || !shortDescription) throw err;
    return { version: await send(shortDescription), usedShortDescription: true, created: !existing };
  }
}

/** Adds the version to an issue's Fix Version field without removing any existing ones. */
async function addFixVersion(issueKey, versionName) {
  await request("PUT", `/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
    update: { fixVersions: [{ add: { name: versionName } }] },
  });
}

function versionUrl(projectKey, versionId) {
  return `${config().baseUrl}/projects/${projectKey}/versions/${versionId}`;
}

/** Plain-text rendering of the markdown notes, since version descriptions don't render markdown. */
function markdownToPlainText(markdown) {
  return String(markdown || "")
    .split("\n")
    .map((line) => {
      const heading = line.match(/^#{1,6}\s+(.*)$/);
      if (heading) return heading[1].toUpperCase();
      return line.replace(/^[-*]\s+/, "• ");
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

module.exports = {
  config,
  extractTicketKey,
  getIssue,
  findVersion,
  upsertVersion,
  addFixVersion,
  versionUrl,
  markdownToPlainText,
  JiraError,
};
