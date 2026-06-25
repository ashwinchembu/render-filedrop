import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";

const port = Number(process.env.PORT || 8787);
const secret = process.env.FILEDROP_WEBHOOK_SECRET || "";
const inboxPath = process.env.FILEDROP_WEBHOOK_INBOX || "webhook-inbox.jsonl";

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
