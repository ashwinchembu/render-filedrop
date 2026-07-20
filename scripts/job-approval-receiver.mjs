import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

const port = Number(process.env.FILEDROP_JOB_APPROVAL_PORT || 8790);
const secret = process.env.FILEDROP_WEBHOOK_SECRET || "";
const stateDir = process.env.TELEGRAM_APPROVAL_STATE_DIR || path.join(process.cwd(), "tmp", "approval_bridge");
const decisionLog = path.join(stateDir, "approval_decisions.jsonl");

function validSignature(body, signature) {
  if (!secret) return false;
  const expected = Buffer.from(`sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`);
  const provided = Buffer.from(signature || "");
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function appendDecision(record) {
  await fs.mkdir(stateDir, { recursive: true });
  let existing = "";
  try { existing = await fs.readFile(decisionLog, "utf8"); } catch {}
  const duplicate = existing.split(/\r?\n/).filter(Boolean).some((line) => {
    try {
      const prior = JSON.parse(line);
      return prior.approvalId === record.approvalId && prior.telegramUpdateId === record.telegramUpdateId;
    } catch { return false; }
  });
  if (!duplicate) await fs.appendFile(decisionLog, `${JSON.stringify(record)}\n`);
  return !duplicate;
}

http.createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/webhook") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Use POST /webhook" }));
    return;
  }
  const body = await readBody(req);
  if (!validSignature(body, req.headers["x-filedrop-signature"])) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid Filedrop signature" }));
    return;
  }
  try {
    const event = JSON.parse(body);
    const message = event?.data?.message;
    if (event?.event !== "message.created" || message?.to !== "job-approval-worker" || message?.category !== "job-approval") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ignored: true }));
      return;
    }
    const record = JSON.parse(message.body);
    if (!/^(APPROVE|REJECT)$/.test(record.decision) || !/^[A-Za-z0-9._:-]+$/.test(record.approvalId || "")) throw new Error("Invalid approval event");
    const accepted = await appendDecision(record);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, accepted }));
  } catch (error) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: error.message }));
  }
}).listen(port, () => console.log(`Job approval receiver listening on http://127.0.0.1:${port}/webhook`));
