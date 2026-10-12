const https = require("https");

/**
 * Incoming Webhooks are Slack's simplest integration: a single URL that
 * posts a message to one pre-configured channel when you POST JSON to it.
 * No bot token, no OAuth scopes beyond what's needed to create the
 * webhook itself, and critically: no server needed to receive anything
 * back, since this is one-directional (we send, Slack just posts it).
 * This is what replaces the entire Bolt app from the always-on version.
 */
function postToSlack(blocksOrText, fallbackText) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) {
    throw new Error("SLACK_WEBHOOK_URL is not set");
  }

  const payload =
    typeof blocksOrText === "string"
      ? { text: blocksOrText }
      : { text: fallbackText || "Release Agent update", blocks: blocksOrText };

  const body = JSON.stringify(payload);
  const parsed = new URL(url);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            reject(new Error(`Slack webhook POST failed (${res.statusCode}): ${data}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

module.exports = { postToSlack };
