import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";

const port = Number(process.env.PORT || 8787);
const secret = process.env.FILEDROP_WEBHOOK_SECRET || "";
const inboxPath = process.env.FILEDROP_WEBHOOK_INBOX || "webhook-inbox.jsonl";
const notificationConfigPath = process.env.FILEDROP_NOTIFICATION_CONFIG || "";
const notifyCategories = new Set([
  "completion",
  "urgent-correction-complete",
  "blocker",
  "error",
  "status",
]);

function verifySignature(rawBody, signature) {
  if (!secret) return true;
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const provided = Buffer.from(signature || "");
  const expectedBuffer = Buffer.from(expected);
  return provided.length === expectedBuffer.length && crypto.timingSafeEqual(provided, expectedBuffer);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function readNotificationConfig() {
  if (!notificationConfigPath) return { enabled: false };
  try {
    return JSON.parse(await fs.readFile(notificationConfigPath, "utf8"));
  } catch (error) {
    console.error(`Could not read notification config: ${error.message}`);
    return { enabled: false };
  }
}

function shouldNotify(message) {
  if (!message) return false;
  if (notifyCategories.has(message.category || "")) return true;
  const tags = Array.isArray(message.tags) ? message.tags : [];
  return tags.some((tag) => ["completed", "complete", "blocker", "urgent"].includes(tag));
}

function formatNotification(message) {
  const title = `Codex task ${message.category || "update"}`;
  const project = message.project ? `Project: ${message.project}\n` : "";
  const from = message.from ? `From: ${message.from}\n` : "";
  const body = (message.body || "").replace(/\s+/g, " ").trim();
  const clipped = body.length > 700 ? `${body.slice(0, 700)}...` : body;
  return `${title}\n${project}${from}${clipped}`;
}

async function sendTelegram(config, text) {
  const token = config.telegram?.botToken;
  const chatId = config.telegram?.chatId;
  if (!token || !chatId) return;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    console.error(`Telegram notification failed: ${res.status} ${await res.text()}`);
  }
}

async function sendIMessage(config, text) {
  const recipient = config.imessage?.recipient;
  if (!recipient) return;
  const script = `
    on run argv
      with timeout of 10 seconds
        tell application "Messages"
          set targetBuddy to item 1 of argv
          set msgText to item 2 of argv
          send msgText to buddy targetBuddy of service "iMessage"
        end tell
      end timeout
    end run
  `;
  await new Promise((resolve) => {
    const child = spawn("/usr/bin/osascript", ["-e", script, recipient, text], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (data) => console.log(`iMessage notification stdout: ${data}`));
    child.stderr.on("data", (data) => console.error(`iMessage notification stderr: ${data}`));
    child.on("exit", (code, signal) => {
      if (code !== 0) console.error(`iMessage notification failed with code=${code} signal=${signal}`);
      resolve();
    });
  });
}

async function notifyIfNeeded(message) {
  if (!shouldNotify(message)) return;
  const config = await readNotificationConfig();
  if (!config.enabled) return;
  const text = formatNotification(message);
  if (config.telegram?.enabled) await sendTelegram(config, text);
  if (config.imessage?.enabled) await sendIMessage(config, text);
}

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/webhook") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Use POST /webhook" }));
    return;
  }

  const rawBody = await readBody(req);
  if (!verifySignature(rawBody, req.headers["x-filedrop-signature"])) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid signature" }));
    return;
  }

  const event = JSON.parse(rawBody);
  await fs.appendFile(inboxPath, `${JSON.stringify(event)}\n`);

  const message = event.data?.message;
  console.log("");
  console.log(`[${new Date().toLocaleString()}] ${event.event}`);
  if (message) {
    console.log(`${message.from} -> ${message.to}`);
    console.log(message.body);
    if (message.relatedUrl) console.log(`URL: ${message.relatedUrl}`);
    if (message.relatedFileId) console.log(`File: ${message.relatedFileId}`);
    await notifyIfNeeded(message);
  } else {
    console.log(rawBody);
  }
  console.log("");

  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
});

server.listen(port, () => {
  console.log(`Filedrop webhook receiver listening on http://127.0.0.1:${port}/webhook`);
  console.log(`Appending events to ${inboxPath}`);
  if (secret) console.log("Signature verification enabled.");
});
