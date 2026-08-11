import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import helmet from "helmet";
import multer from "multer";
import * as z from "zod/v4";
import {
  buildOrganizedMetadataObjects,
  normalizeStoragePrefix,
  storageObjectKey
} from "./storage-layout.js";
import {
  claimJob,
  enqueueJob,
  heartbeatJob,
  listJobs,
  recoverStaleJobs,
  transitionJob
} from "./job-queue.js";

const app = express();
app.set("trust proxy", true);
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST;
let storageDir = process.env.STORAGE_DIR || path.resolve("data");
const storageDriver = process.env.STORAGE_DRIVER || "local";
const uploadPassword = process.env.UPLOAD_PASSWORD || "";
const apiKey = process.env.API_KEY || "";
const maxUploadMb = Number(process.env.MAX_UPLOAD_MB || 250);
const s3Bucket = process.env.S3_BUCKET || "";
const s3Prefix = normalizeStoragePrefix(process.env.S3_PREFIX || "filedrop");
const s3Region = process.env.S3_REGION || "us-east-1";
const s3Endpoint = process.env.S3_ENDPOINT || undefined;
const s3ForcePathStyle = process.env.S3_FORCE_PATH_STYLE === "true";
const telegramApprovalSecret = process.env.TELEGRAM_APPROVAL_WEBHOOK_SECRET || "";
const telegramApprovalChatId = process.env.TELEGRAM_APPROVAL_CHAT_ID || "";
const telegramApprovalBotToken = process.env.TELEGRAM_APPROVAL_BOT_TOKEN || "";

let filesDir = path.join(storageDir, "files");
let metaPath = path.join(storageDir, "metadata.json");
const mcpTransports = {};

const s3 =
  storageDriver === "s3"
    ? new S3Client({
        region: s3Region,
        endpoint: s3Endpoint,
        forcePathStyle: s3ForcePathStyle
      })
    : null;

if (storageDriver === "local") {
  try {
    await fs.mkdir(filesDir, { recursive: true });
  } catch (error) {
    if (error?.code !== "EACCES" || !storageDir.startsWith("/var/data")) {
      throw error;
    }
    storageDir = "/tmp/filedrop";
    filesDir = path.join(storageDir, "files");
    metaPath = path.join(storageDir, "metadata.json");
    console.warn(
      "Persistent disk path is not writable yet; temporarily using /tmp/filedrop."
    );
    await fs.mkdir(filesDir, { recursive: true });
  }
}

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"]
      }
    }
  })
);
app.use(express.json({ limit: "1mb" }));
app.get("/approvals", (_req, res) => {
  res.sendFile(path.resolve("public/approvals/index.html"));
});
app.use(express.static(path.resolve("public")));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxUploadMb * 1024 * 1024 }
});

function s3Key(name) {
  return s3Prefix ? `${s3Prefix}/${name}` : name;
}

function storageConfigured() {
  return storageDriver === "local" || Boolean(s3 && s3Bucket);
}

function cleanText(value, maxLength = 200) {
  return String(value || "").trim().slice(0, maxLength);
}

function cleanTags(value) {
  return String(value || "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 12);
}

async function readMeta() {
  if (storageDriver === "s3") {
    if (!s3Bucket) return { files: [] };
    try {
      const result = await s3.send(new GetObjectCommand({ Bucket: s3Bucket, Key: s3Key("metadata.json") }));
      const text = await result.Body.transformToString();
      return JSON.parse(text);
    } catch (error) {
      if (error.name === "NoSuchKey" || error.$metadata?.httpStatusCode === 404) return { files: [] };
      throw error;
    }
  }

  try {
    return JSON.parse(await fs.readFile(metaPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { files: [] };
    throw error;
  }
}

async function writeMeta(meta) {
  if (storageDriver === "s3") {
    await s3.send(
      new PutObjectCommand({
        Bucket: s3Bucket,
        Key: s3Key("metadata.json"),
        Body: JSON.stringify(meta, null, 2),
        ContentType: "application/json"
      })
    );
    return;
  }

  const tempPath = `${metaPath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(meta, null, 2));
  await fs.rename(tempPath, metaPath);
}

let jobMutation = Promise.resolve();

async function mutateJobs(mutator) {
  const run = jobMutation.then(async () => {
    const meta = await readMeta();
    const result = await mutator(meta);
    await writeMeta(meta);
    return result;
  });
  jobMutation = run.catch(() => {});
  return run;
}

async function writeFileObject(storageName, file) {
  if (storageDriver === "s3") {
    await s3.send(
      new PutObjectCommand({
        Bucket: s3Bucket,
        Key: s3Key(`files/${storageName}`),
        Body: file.buffer,
        ContentType: file.mimetype || "application/octet-stream"
      })
    );
    return;
  }

  await fs.writeFile(path.join(filesDir, storageName), file.buffer);
}

async function deleteFileObject(storageName) {
  if (!storageName) return;
  if (storageDriver === "s3") {
    await s3.send(new DeleteObjectCommand({ Bucket: s3Bucket, Key: s3Key(`files/${storageName}`) }));
    return;
  }

  try {
    await fs.unlink(path.join(filesDir, storageName));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function saveBufferFile({ buffer, originalname, mimetype, size }, body = {}) {
  return saveUploadedFile({ buffer, originalname, mimetype, size }, body);
}

async function sendFileObject(res, file) {
  res.setHeader("Content-Type", file.mimeType || "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(file.originalName)}"`);

  if (storageDriver === "s3") {
    const result = await s3.send(new GetObjectCommand({ Bucket: s3Bucket, Key: s3Key(`files/${file.storageName}`) }));
    await pipeline(Readable.fromWeb(result.Body.transformToWebStream()), res);
    return;
  }

  res.download(path.join(filesDir, file.storageName), file.originalName);
}

function requireConfiguredSecret(secret, name) {
  return (_req, res, next) => {
    if (!secret) {
      res.status(503).json({ error: `${name} is not configured` });
      return;
    }
    next();
  };
}

function requireWebPassword(req, res, next) {
  const password = req.header("x-upload-password") || req.body?.password;
  const provided = Buffer.from(password || "");
  const expected = Buffer.from(uploadPassword);
  if (provided.length === expected.length && crypto.timingSafeEqual(provided, expected)) {
    next();
    return;
  }
  res.status(401).json({ error: "Invalid upload password" });
}

function requireApiKey(req, res, next) {
  if (hasValidApiKey(req)) {
    next();
    return;
  }
  res.status(401).json({ error: "Invalid API key" });
}

function hasValidApiKey(req) {
  const auth = req.header("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : req.header("x-api-key");
  const provided = Buffer.from(token || "");
  const expected = Buffer.from(apiKey);
  if (provided.length === expected.length && crypto.timingSafeEqual(provided, expected)) {
    return true;
  }
  return false;
}

function hasValidTelegramApprovalSecret(req) {
  const provided = Buffer.from(req.header("x-telegram-bot-api-secret-token") || "");
  const expected = Buffer.from(telegramApprovalSecret);
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

async function acknowledgeTelegramApproval(callback, decision, approvalId) {
  if (!telegramApprovalBotToken || !callback?.id) return;
  const api = `https://api.telegram.org/bot${telegramApprovalBotToken}`;
  const request = async (method, payload) => {
    const response = await fetch(`${api}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) console.error(`Telegram ${method} failed: ${response.status}`);
  };
  await request("answerCallbackQuery", {
    callback_query_id: callback.id,
    text: `${decision} recorded. The application has not been submitted yet.`
  });
  if (callback.message?.chat?.id && callback.message?.message_id) {
    await request("editMessageReplyMarkup", {
      chat_id: callback.message.chat.id,
      message_id: callback.message.message_id,
      reply_markup: { inline_keyboard: [] }
    });
  }
  await request("sendMessage", {
    chat_id: callback.message?.chat?.id,
    text: `${decision === "APPROVE" ? "✅ Approval" : "↩️ Rejection"} recorded for ${approvalId}. The local processor will verify the prepared form before any final submission.`
  });
}

function publicFile(file, req) {
  return {
    id: file.id,
    name: file.originalName,
    size: file.size,
    mimeType: file.mimeType,
    uploadedAt: file.uploadedAt,
    category: file.category || "",
    tags: Array.isArray(file.tags) ? file.tags : [],
    note: file.note || "",
    project: file.project || "",
    path: file.path || "",
    version: file.version || 1,
    parentId: file.parentId || "",
    commitMessage: file.commitMessage || "",
    downloadUrl: `${req.protocol}://${req.get("host")}/d/${file.downloadToken}`
  };
}

function applyFileMetadata(record, body = {}) {
  if (Object.hasOwn(body, "category")) record.category = cleanText(body.category, 80);
  if (Object.hasOwn(body, "tags")) {
    record.tags = Array.isArray(body.tags) ? body.tags.map((tag) => cleanText(tag, 40)).filter(Boolean) : cleanTags(body.tags);
  }
  if (Object.hasOwn(body, "note")) record.note = cleanText(body.note, 500);
  if (Object.hasOwn(body, "project")) record.project = cleanText(body.project, 120);
  if (Object.hasOwn(body, "path")) record.path = cleanText(body.path, 300).replace(/^\/+/, "");
  if (Object.hasOwn(body, "commitMessage")) record.commitMessage = cleanText(body.commitMessage, 500);
  return record;
}

function lineageFor(files, id) {
  const byId = new Map(files.map((file) => [file.id, file]));
  const chain = [];
  let current = byId.get(id);
  while (current) {
    chain.push(current);
    current = current.parentId ? byId.get(current.parentId) : null;
  }
  return chain.reverse();
}

function latestFiles(files) {
  const parentIds = new Set(files.map((file) => file.parentId).filter(Boolean));
  return files.filter((file) => !parentIds.has(file.id));
}

function projectSummary(files) {
  const projects = new Map();
  for (const file of files) {
    const name = file.project || "Unprojected";
    const entry = projects.get(name) || {
      name,
      files: 0,
      versions: 0,
      latestUpload: ""
    };
    entry.versions += 1;
    if (!files.some((candidate) => candidate.parentId === file.id)) entry.files += 1;
    if (!entry.latestUpload || file.uploadedAt > entry.latestUpload) entry.latestUpload = file.uploadedAt;
    projects.set(name, entry);
  }
  return Array.from(projects.values()).sort((a, b) => (b.latestUpload || "").localeCompare(a.latestUpload || ""));
}

function definedMetadata(input = {}) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function publicMessage(message) {
  return {
    id: message.id,
    from: message.from || "",
    to: message.to || "",
    body: message.body || "",
    createdAt: message.createdAt,
    project: message.project || "",
    category: message.category || "",
    tags: Array.isArray(message.tags) ? message.tags : [],
    relatedFileId: message.relatedFileId || "",
    relatedUrl: message.relatedUrl || "",
    readAt: message.readAt || ""
  };
}

async function createMessage(body = {}) {
  const text = cleanText(body.body, 4000);
  if (!text) {
    const error = new Error("Missing message body");
    error.statusCode = 400;
    throw error;
  }

  const meta = await readMeta();
  meta.messages ||= [];
  const message = {
    id: crypto.randomUUID(),
    from: cleanText(body.from, 80) || "unknown",
    to: cleanText(body.to, 80) || "all",
    body: text,
    createdAt: new Date().toISOString(),
    project: cleanText(body.project, 120),
    category: cleanText(body.category, 80),
    tags: Array.isArray(body.tags) ? body.tags.map((tag) => cleanText(tag, 40)).filter(Boolean) : cleanTags(body.tags),
    relatedFileId: cleanText(body.relatedFileId, 80),
    relatedUrl: cleanText(body.relatedUrl, 500),
    readAt: ""
  };
  meta.messages.unshift(message);
  await writeMeta(meta);
  await triggerWebhooks("message.created", { message: publicMessage(message) });
  return message;
}

function filterMessages(messages = [], { to, from, since, unreadOnly, project, category, tag } = {}) {
  return messages.filter((message) => {
    if (to && !["all", to].includes(message.to || "all")) return false;
    if (from && message.from !== from) return false;
    if (since && message.createdAt <= since) return false;
    if (unreadOnly && message.readAt) return false;
    if (project && message.project !== project) return false;
    if (category && message.category !== category) return false;
    if (tag && !(Array.isArray(message.tags) && message.tags.includes(tag))) return false;
    return true;
  });
}

async function markMessageRead(id) {
  const meta = await readMeta();
  meta.messages ||= [];
  const message = meta.messages.find((item) => item.id === id);
  if (!message) return null;
  message.readAt = new Date().toISOString();
  await writeMeta(meta);
  return message;
}

function channelId(value) {
  return cleanText(value, 120)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "general";
}

function publicChannel(channel) {
  return {
    id: channel.id,
    name: channel.name || channel.id,
    description: channel.description || "",
    category: channel.category || "",
    tags: Array.isArray(channel.tags) ? channel.tags : [],
    createdAt: channel.createdAt,
    updatedAt: channel.updatedAt || channel.createdAt
  };
}

function publicChannelMessage(message) {
  return {
    id: message.id,
    channelId: message.channelId,
    from: message.from || "",
    body: message.body || "",
    createdAt: message.createdAt,
    category: message.category || "",
    tags: Array.isArray(message.tags) ? message.tags : [],
    relatedFileId: message.relatedFileId || "",
    relatedUrl: message.relatedUrl || "",
    readAt: message.readAt || ""
  };
}

async function upsertChannel(body = {}) {
  const meta = await readMeta();
  meta.channels ||= [];
  const id = channelId(body.id || body.name);
  let channel = meta.channels.find((item) => item.id === id);
  if (!channel) {
    channel = {
      id,
      name: cleanText(body.name, 120) || id,
      description: "",
      category: "",
      tags: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    meta.channels.unshift(channel);
  }
  if (Object.hasOwn(body, "name")) channel.name = cleanText(body.name, 120) || channel.name;
  if (Object.hasOwn(body, "description")) channel.description = cleanText(body.description, 500);
  if (Object.hasOwn(body, "category")) channel.category = cleanText(body.category, 80);
  if (Object.hasOwn(body, "tags")) {
    channel.tags = Array.isArray(body.tags) ? body.tags.map((tag) => cleanText(tag, 40)).filter(Boolean) : cleanTags(body.tags);
  }
  channel.updatedAt = new Date().toISOString();
  await writeMeta(meta);
  return channel;
}

async function createChannelMessage(channelValue, body = {}) {
  const text = cleanText(body.body, 8000);
  if (!text) {
    const error = new Error("Missing message body");
    error.statusCode = 400;
    throw error;
  }

  const meta = await readMeta();
  meta.channels ||= [];
  meta.channelMessages ||= [];
  const id = channelId(channelValue);
  let channel = meta.channels.find((item) => item.id === id);
  if (!channel) {
    channel = {
      id,
      name: cleanText(body.channelName, 120) || id,
      description: "",
      category: cleanText(body.category, 80),
      tags: Array.isArray(body.tags) ? body.tags.map((tag) => cleanText(tag, 40)).filter(Boolean) : cleanTags(body.tags),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    meta.channels.unshift(channel);
  }
  channel.updatedAt = new Date().toISOString();

  const message = {
    id: crypto.randomUUID(),
    channelId: id,
    from: cleanText(body.from, 80) || "unknown",
    body: text,
    createdAt: new Date().toISOString(),
    category: cleanText(body.category, 80) || channel.category || "",
    tags: Array.isArray(body.tags) ? body.tags.map((tag) => cleanText(tag, 40)).filter(Boolean) : cleanTags(body.tags),
    relatedFileId: cleanText(body.relatedFileId, 80),
    relatedUrl: cleanText(body.relatedUrl, 500),
    readAt: ""
  };
  meta.channelMessages.unshift(message);
  await writeMeta(meta);
  await triggerWebhooks("channel.message.created", {
    channel: publicChannel(channel),
    message: publicChannelMessage(message)
  });
  return message;
}

function filterChannelMessages(messages = [], { channelId: id, from, since, unreadOnly, category, tag } = {}) {
  return messages.filter((message) => {
    if (id && message.channelId !== channelId(id)) return false;
    if (from && message.from !== from) return false;
    if (since && message.createdAt <= since) return false;
    if (unreadOnly && message.readAt) return false;
    if (category && message.category !== category) return false;
    if (tag && !(Array.isArray(message.tags) && message.tags.includes(tag))) return false;
    return true;
  });
}

async function markChannelMessageRead(channelValue, id) {
  const meta = await readMeta();
  meta.channelMessages ||= [];
  const expectedChannelId = channelId(channelValue);
  const message = meta.channelMessages.find((item) => item.id === id && item.channelId === expectedChannelId);
  if (!message) return null;
  message.readAt = new Date().toISOString();
  await writeMeta(meta);
  return message;
}

function publicWebhook(webhook) {
  return {
    id: webhook.id,
    name: webhook.name || "",
    url: webhook.url,
    event: webhook.event || "message.created",
    to: webhook.to || "",
    channelId: webhook.channelId || "",
    createdAt: webhook.createdAt,
    hasSecret: Boolean(webhook.secret)
  };
}

async function createWebhook(body = {}) {
  let url;
  try {
    url = new URL(String(body.url || ""));
  } catch {
    const error = new Error("Invalid webhook URL");
    error.statusCode = 400;
    throw error;
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    const error = new Error("Webhook URL must use http or https");
    error.statusCode = 400;
    throw error;
  }

  const meta = await readMeta();
  meta.webhooks ||= [];
  const webhook = {
    id: crypto.randomUUID(),
    name: cleanText(body.name, 120) || url.hostname,
    url: url.toString(),
    event: cleanText(body.event, 80) || "message.created",
    to: cleanText(body.to, 80),
    channelId: cleanText(body.channelId, 120) ? channelId(body.channelId) : "",
    secret: cleanText(body.secret, 200) || crypto.randomBytes(24).toString("base64url"),
    createdAt: new Date().toISOString()
  };
  meta.webhooks.unshift(webhook);
  await writeMeta(meta);
  return webhook;
}

async function deleteWebhook(id) {
  const meta = await readMeta();
  meta.webhooks ||= [];
  const previousLength = meta.webhooks.length;
  meta.webhooks = meta.webhooks.filter((webhook) => webhook.id !== id);
  if (meta.webhooks.length === previousLength) return false;
  await writeMeta(meta);
  return true;
}

function webhookMatches(webhook, event, payload) {
  if ((webhook.event || "message.created") !== event) return false;
  if (event === "message.created") {
    if (!webhook.to) return true;
    const messageTo = payload?.message?.to || "";
    return messageTo === webhook.to || messageTo === "all";
  }
  if (event === "channel.message.created") {
    if (!webhook.channelId) return true;
    return payload?.message?.channelId === webhook.channelId;
  }
  return true;
}

function signWebhook(secret, body) {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

async function deliverWebhook(webhook, event, payload) {
  const deliveryId = crypto.randomUUID();
  const body = JSON.stringify({
    id: deliveryId,
    event,
    createdAt: new Date().toISOString(),
    data: payload
  });
  const headers = {
    "content-type": "application/json",
    "x-filedrop-event": event,
    "x-filedrop-delivery": deliveryId
  };
  if (webhook.secret) headers["x-filedrop-signature"] = signWebhook(webhook.secret, body);

  const response = await fetch(webhook.url, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(`Webhook ${webhook.id} failed: ${response.status}`);
}

async function triggerWebhooks(event, payload) {
  const meta = await readMeta();
  const webhooks = (meta.webhooks || []).filter((webhook) => webhookMatches(webhook, event, payload));
  if (!webhooks.length) return [];
  const deliveries = await Promise.allSettled(webhooks.map((webhook) => deliverWebhook(webhook, event, payload)));
  deliveries.forEach((delivery, index) => {
    if (delivery.status === "rejected") {
      console.error(`Webhook delivery failed for ${webhooks[index].id}:`, delivery.reason);
    }
  });
  return deliveries;
}

async function saveUploadedFile(file, body = {}) {
  if (!storageConfigured()) {
    const error = new Error("Storage is not configured");
    error.statusCode = 503;
    throw error;
  }

  const meta = await readMeta();
  const safeExt = path.extname(file.originalname).replace(/[^a-zA-Z0-9.]/g, "");
  const parent = body.parentId ? meta.files.find((item) => item.id === body.parentId) : null;
  if (body.parentId && !parent) {
    const error = new Error("Parent file not found");
    error.statusCode = 404;
    throw error;
  }
  const record = {
    id: crypto.randomUUID(),
    storageName: `${crypto.randomUUID()}${safeExt}`,
    originalName: cleanText(body.name, 240) || file.originalname,
    mimeType: file.mimetype || "application/octet-stream",
    size: file.size,
    uploadedAt: new Date().toISOString(),
    downloadToken: crypto.randomBytes(24).toString("base64url"),
    parentId: parent?.id || "",
    version: parent ? Math.max(...lineageFor(meta.files, parent.id).map((item) => item.version || 1)) + 1 : 1,
    category: "",
    tags: [],
    note: "",
    project: "",
    path: "",
    commitMessage: ""
  };
  if (parent) {
    record.project = parent.project || "";
    record.path = parent.path || "";
    record.category = parent.category || "";
    record.tags = Array.isArray(parent.tags) ? parent.tags : [];
  }
  applyFileMetadata(record, body);
  await writeFileObject(record.storageName, file);
  meta.files.unshift(record);
  await writeMeta(meta);
  return record;
}

async function updateFileMetadata(id, body) {
  const meta = await readMeta();
  const file = meta.files.find((item) => item.id === id);
  if (!file) return null;
  applyFileMetadata(file, body);
  await writeMeta(meta);
  return file;
}

function mcpRequest(req) {
  const protocol = req.header("x-forwarded-proto") || req.protocol;
  const hostName = req.get("host");
  return { protocol, get: (name) => (name.toLowerCase() === "host" ? hostName : req.get(name)) };
}

function mcpTextAndStructured(text, structuredContent = {}) {
  return {
    content: [{ type: "text", text }],
    structuredContent
  };
}

function filterFiles(files, query) {
  const needle = cleanText(query, 120).toLowerCase();
  if (!needle) return files;
  return files.filter((file) => {
    const haystack = [
      file.originalName,
      file.category,
      file.note,
      file.project,
      file.path,
      file.commitMessage,
      ...(Array.isArray(file.tags) ? file.tags : [])
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle);
  });
}

function groupFiles(files, groupBy) {
  if (!groupBy || groupBy === "none") return {};

  return files.reduce((groups, file) => {
    const date = new Date(file.uploadedAt);
    let key = file.category || "Uncategorized";
    if (groupBy === "day") key = Number.isNaN(date.valueOf()) ? "Unknown date" : date.toISOString().slice(0, 10);
    if (groupBy === "month") key = Number.isNaN(date.valueOf()) ? "Unknown month" : date.toISOString().slice(0, 7);
    if (groupBy === "project") key = file.project || "Unprojected";
    groups[key] ||= [];
    groups[key].push(file.id);
    return groups;
  }, {});
}

async function importChatGptRefs(refs, body, req) {
  if (!Array.isArray(refs) || !refs.length) {
    const error = new Error("Missing openaiFileIdRefs");
    error.statusCode = 400;
    throw error;
  }
  if (refs.length > 10) {
    const error = new Error("Only up to 10 files can be imported at once");
    error.statusCode = 400;
    throw error;
  }

  const imported = [];
  for (const ref of refs) {
    const downloadLink = ref?.download_link || ref?.downloadLink;
    if (!downloadLink) continue;

    const response = await fetch(downloadLink);
    if (!response.ok) {
      throw new Error(`Could not fetch ${ref.name || ref.id || "file"}: ${response.status}`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    const record = await saveBufferFile(
      {
        buffer: bytes,
        originalname: ref.name || "chatgpt-upload",
        mimetype: ref.mime_type || ref.mimeType || response.headers.get("content-type") || "application/octet-stream",
        size: bytes.length
      },
      body
    );
    imported.push(publicFile(record, req));
  }

  return imported;
}

async function saveUrlFile({ url, name, category, tags, note }, req) {
  const response = await fetch(url);
  if (!response.ok) {
    const error = new Error(`Could not fetch URL: ${response.status}`);
    error.statusCode = 400;
    throw error;
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const parsedUrl = new URL(url);
  const fallbackName = path.basename(parsedUrl.pathname) || "download";
  const record = await saveBufferFile(
    {
      buffer: bytes,
      originalname: cleanText(name, 240) || decodeURIComponent(fallbackName),
      mimetype: response.headers.get("content-type") || "application/octet-stream",
      size: bytes.length
    },
    { category, tags, note }
  );
  return publicFile(record, req);
}

async function saveUrlFileWithMetadata({ url, name, category, tags, note, project, path: filePath, commitMessage, parentId }, req) {
  const response = await fetch(url);
  if (!response.ok) {
    const error = new Error(`Could not fetch URL: ${response.status}`);
    error.statusCode = 400;
    throw error;
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const parsedUrl = new URL(url);
  const fallbackName = path.basename(parsedUrl.pathname) || "download";
  const record = await saveBufferFile(
    {
      buffer: bytes,
      originalname: cleanText(name, 240) || decodeURIComponent(fallbackName),
      mimetype: response.headers.get("content-type") || "application/octet-stream",
      size: bytes.length
    },
    definedMetadata({ category, tags, note, project, path: filePath, commitMessage, parentId })
  );
  return publicFile(record, req);
}

function createAdminS3Client(body = {}) {
  const config = {
    region: cleanText(body.region, 80) || s3Region,
    endpoint: cleanText(body.endpoint, 500) || undefined,
    forcePathStyle: body.forcePathStyle === true
  };
  if (body.accessKeyId || body.secretAccessKey) {
    config.credentials = {
      accessKeyId: String(body.accessKeyId || ""),
      secretAccessKey: String(body.secretAccessKey || "")
    };
  }
  return new S3Client(config);
}

async function s3ObjectExists(client, bucket, key) {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (error) {
    if (error.name === "NotFound" || error.$metadata?.httpStatusCode === 404) return false;
    throw error;
  }
}

async function migrateLocalStorageToS3(body = {}) {
  if (storageDriver !== "local") {
    const error = new Error("Migration can only run while STORAGE_DRIVER is local");
    error.statusCode = 409;
    throw error;
  }

  const bucket = cleanText(body.bucket, 200) || s3Bucket;
  if (!bucket) {
    const error = new Error("S3 bucket is required");
    error.statusCode = 400;
    throw error;
  }

  const prefix = normalizeStoragePrefix(body.prefix ?? s3Prefix);
  const dryRun = body.dryRun !== false;
  const client = createAdminS3Client(body);
  const meta = await readMeta();
  const files = Array.isArray(meta.files) ? meta.files : [];
  const result = {
    sourceStorageDir: storageDir,
    target: { bucket, prefix },
    dryRun,
    fileRecords: files.length,
    uploaded: [],
    existing: [],
    missing: []
  };

  for (const file of files) {
    if (!file.storageName) continue;
    const key = storageObjectKey(prefix, `files/${file.storageName}`);
    const exists = await s3ObjectExists(client, bucket, key);
    if (exists) {
      result.existing.push({ id: file.id, key });
      continue;
    }

    const sourcePath = path.join(filesDir, file.storageName);
    let bytes;
    try {
      bytes = await fs.readFile(sourcePath);
    } catch (error) {
      if (error.code === "ENOENT") {
        result.missing.push({ id: file.id, storageName: file.storageName });
        continue;
      }
      throw error;
    }

    if (!dryRun) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: bytes,
          ContentType: file.mimeType || "application/octet-stream"
        })
      );
    }
    result.uploaded.push({ id: file.id, key, size: bytes.length });
  }

  const metadataKey = storageObjectKey(prefix, "metadata.json");
  const metadataBody = JSON.stringify(meta, null, 2);
  if (!dryRun) {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: metadataKey,
        Body: metadataBody,
        ContentType: "application/json"
      })
    );
  }
  const organizedObjects = buildOrganizedMetadataObjects(meta);
  for (const object of organizedObjects) {
    const key = storageObjectKey(prefix, object.key);
    if (!dryRun) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: object.body,
          ContentType: object.contentType
        })
      );
    }
  }
  result.metadata = { key: metadataKey, bytes: Buffer.byteLength(metadataBody) };
  result.organized = {
    objects: organizedObjects.length,
    keys: organizedObjects.map((object) => storageObjectKey(prefix, object.key))
  };
  return result;
}

function createMcpServer(req) {
  const server = new McpServer({
    name: "private-filedrop",
    version: "1.0.0"
  });
  const publicReq = mcpRequest(req);

  server.registerTool(
    "list_files",
    {
      title: "List files",
      description: "List stored files, optionally filtered and grouped by day, month, or category.",
      inputSchema: {
        query: z.string().optional().describe("Optional search text for filename, category, tags, or notes."),
        groupBy: z.enum(["none", "day", "month", "category", "project"]).optional().describe("How to group the returned files."),
        latestOnly: z.boolean().optional().describe("Return only the newest version in each version chain.")
      }
    },
    async ({ query, groupBy = "day", latestOnly = false }) => {
      const meta = await readMeta();
      const sourceFiles = latestOnly ? latestFiles(meta.files) : meta.files;
      const files = filterFiles(sourceFiles, query).map((file) => publicFile(file, publicReq));
      const groups = groupFiles(files.map((file) => ({
        id: file.id,
        category: file.category,
        project: file.project,
        uploadedAt: file.uploadedAt
      })), groupBy);
      const summary = files.length
        ? files.map((file) => `${file.id} | v${file.version} | ${file.project || "Unprojected"} | ${file.path || file.name}`).join("\n")
        : "No files found.";
      return mcpTextAndStructured(summary, { files, groups });
    }
  );

  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description: "List GitHub-like project buckets with file and version counts.",
      inputSchema: {}
    },
    async () => {
      const meta = await readMeta();
      const projects = projectSummary(meta.files);
      const text = projects.length
        ? projects.map((project) => `${project.name} | ${project.files} current file(s), ${project.versions} version(s)`).join("\n")
        : "No projects found.";
      return mcpTextAndStructured(text, { projects });
    }
  );

  server.registerTool(
    "create_channel",
    {
      title: "Create channel",
      description: "Create or update a dedicated message channel, separate from the Codex control mailbox.",
      inputSchema: {
        id: z.string().optional().describe("Stable channel id, e.g. collaboration-demo."),
        name: z.string().describe("Display name, e.g. Collaboration Demo."),
        description: z.string().optional(),
        category: z.string().optional(),
        tags: z.union([z.string(), z.array(z.string())]).optional()
      }
    },
    async (input) => {
      const channel = publicChannel(await upsertChannel(input));
      return mcpTextAndStructured(`Channel ready: ${channel.id}.`, { channel });
    }
  );

  server.registerTool(
    "list_channels",
    {
      title: "List channels",
      description: "List dedicated message channels.",
      inputSchema: {}
    },
    async () => {
      const meta = await readMeta();
      const channels = (meta.channels || []).map(publicChannel);
      const text = channels.length
        ? channels.map((channel) => `${channel.id} | ${channel.name} | ${channel.category}`).join("\n")
        : "No channels found.";
      return mcpTextAndStructured(text, { channels });
    }
  );

  server.registerTool(
    "send_channel_message",
    {
      title: "Send channel message",
      description: "Post a message to a dedicated channel, separate from the Codex control mailbox.",
      inputSchema: {
        channelId: z.string().describe("Channel id, e.g. collaboration-demo."),
        from: z.string().optional(),
        body: z.string().describe("Message body."),
        channelName: z.string().optional(),
        category: z.string().optional(),
        tags: z.union([z.string(), z.array(z.string())]).optional(),
        relatedFileId: z.string().optional(),
        relatedUrl: z.url().optional()
      }
    },
    async ({ channelId: inputChannelId, ...body }) => {
      const message = publicChannelMessage(await createChannelMessage(inputChannelId, body));
      return mcpTextAndStructured(`Posted channel message ${message.id} to ${message.channelId}.`, { message });
    }
  );

  server.registerTool(
    "list_channel_messages",
    {
      title: "List channel messages",
      description: "List messages from a dedicated channel.",
      inputSchema: {
        channelId: z.string().describe("Channel id."),
        from: z.string().optional(),
        since: z.string().optional(),
        unreadOnly: z.boolean().optional(),
        category: z.string().optional(),
        tag: z.string().optional()
      }
    },
    async (input) => {
      const meta = await readMeta();
      const messages = filterChannelMessages(meta.channelMessages || [], input).map(publicChannelMessage);
      const text = messages.length
        ? messages.map((message) => `${message.id} | ${message.createdAt} | ${message.from}: ${message.body}`).join("\n")
        : "No channel messages found.";
      return mcpTextAndStructured(text, { messages });
    }
  );

  server.registerTool(
    "send_message",
    {
      title: "Send message",
      description: "Post a mailbox message for another Codex or ChatGPT session.",
      inputSchema: {
        from: z.string().optional().describe("Sender name, such as macbook-codex or work-codex."),
        to: z.string().optional().describe("Recipient name, or all."),
        body: z.string().describe("Message body."),
        project: z.string().optional().describe("Optional project context."),
        category: z.string().optional().describe("Optional message category."),
        tags: z.union([z.string(), z.array(z.string())]).optional().describe("Optional message tags."),
        relatedFileId: z.string().optional().describe("Optional file ID this message refers to."),
        relatedUrl: z.url().optional().describe("Optional URL this message refers to.")
      }
    },
    async (input) => {
      const message = publicMessage(await createMessage(input));
      return mcpTextAndStructured(`Sent message ${message.id} to ${message.to}.`, { message });
    }
  );

  server.registerTool(
    "list_messages",
    {
      title: "List messages",
      description: "List mailbox messages, optionally filtered by recipient, sender, or unread status.",
      inputSchema: {
        to: z.string().optional().describe("Only messages to this recipient, plus all."),
        from: z.string().optional().describe("Only messages from this sender."),
        project: z.string().optional().describe("Only messages in this project/channel."),
        category: z.string().optional().describe("Only messages in this category."),
        tag: z.string().optional().describe("Only messages with this tag."),
        since: z.string().optional().describe("Only messages created after this ISO timestamp."),
        unreadOnly: z.boolean().optional().describe("Only messages that have not been marked read.")
      }
    },
    async (input) => {
      const meta = await readMeta();
      const messages = filterMessages(meta.messages || [], input).map(publicMessage);
      const text = messages.length
        ? messages.map((message) => `${message.id} | ${message.createdAt} | ${message.from} -> ${message.to}: ${message.body}`).join("\n")
        : "No messages found.";
      return mcpTextAndStructured(text, { messages });
    }
  );

  server.registerTool(
    "mark_message_read",
    {
      title: "Mark message read",
      description: "Mark a mailbox message as read.",
      inputSchema: {
        id: z.string().describe("Message ID from list_messages.")
      }
    },
    async ({ id }) => {
      const message = await markMessageRead(id);
      if (!message) throw new Error("Message not found");
      return mcpTextAndStructured(`Marked message ${id} read.`, { message: publicMessage(message) });
    }
  );

  const jobPayloadSchema = z.record(z.string(), z.unknown()).optional();
  const jobOwnerSchema = {
    id: z.string().describe("Durable job ID."),
    device: z.string().describe("Assigned device identity."),
    session: z.string().describe("Assigned Codex/session identity.")
  };

  server.registerTool(
    "enqueue_job",
    {
      title: "Enqueue durable job",
      description: "Create one deduplicated durable job. Credentials and secret-shaped fields are rejected.",
      inputSchema: {
        id: z.string().optional().describe("Optional caller-provided durable job ID."),
        dedupeKey: z.string().describe("Stable idempotency key; reminders with this key return the existing job."),
        title: z.string().describe("Human-readable job title."),
        kind: z.string().optional(),
        project: z.string().optional(),
        priority: z.number().optional(),
        payload: jobPayloadSchema,
        createdBy: z.string().optional(),
        maxAttempts: z.number().int().positive().optional(),
        staleAfterSeconds: z.number().int().positive().optional()
      }
    },
    async (input) => {
      const result = await mutateJobs((meta) => enqueueJob(meta, input));
      const verb = result.created ? "Enqueued" : "Deduplicated";
      return mcpTextAndStructured(`${verb} job ${result.job.id}.`, result);
    }
  );

  server.registerTool(
    "list_jobs",
    {
      title: "List queued jobs",
      description: "List durable jobs by lifecycle state, owner, project, or kind.",
      inputSchema: {
        state: z.enum(["queued", "claimed", "in_progress", "blocked", "completed"]).optional(),
        device: z.string().optional(),
        project: z.string().optional(),
        kind: z.string().optional()
      }
    },
    async (input) => {
      const meta = await readMeta();
      const jobs = listJobs(meta, input);
      const text = jobs.length
        ? jobs.map((job) => `${job.id} | ${job.state} | ${job.assignedDevice || "unassigned"} | ${job.title}`).join("\n")
        : "No jobs found.";
      return mcpTextAndStructured(text, { jobs });
    }
  );

  server.registerTool(
    "get_job",
    {
      title: "Get durable job",
      description: "Get one job including transitions, lease, attempts, and structured outputs.",
      inputSchema: { id: z.string() }
    },
    async ({ id }) => {
      const meta = await readMeta();
      const job = listJobs(meta).find((candidate) => candidate.id === id);
      if (!job) throw Object.assign(new Error("Job not found"), { statusCode: 404 });
      return mcpTextAndStructured(`${job.id} is ${job.state}.`, { job });
    }
  );

  server.registerTool(
    "claim_job",
    {
      title: "Claim next job",
      description: "Atomically claim a queued job for one device/session and start its lease.",
      inputSchema: {
        id: z.string().optional(),
        device: z.string(),
        session: z.string(),
        kind: z.string().optional(),
        project: z.string().optional(),
        leaseSeconds: z.number().int().positive().optional()
      }
    },
    async (input) => {
      const job = await mutateJobs((meta) => claimJob(meta, input));
      return mcpTextAndStructured(job ? `Claimed job ${job.id}.` : "No eligible queued job.", { job });
    }
  );

  server.registerTool(
    "heartbeat_job",
    {
      title: "Heartbeat claimed job",
      description: "Renew the lease for a claimed or in-progress job.",
      inputSchema: { ...jobOwnerSchema, leaseSeconds: z.number().int().positive().optional() }
    },
    async (input) => {
      const job = await mutateJobs((meta) => heartbeatJob(meta, input));
      return mcpTextAndStructured(`Heartbeat renewed for ${job.id} until ${job.lease.expiresAt}.`, { job });
    }
  );

  server.registerTool(
    "update_job",
    {
      title: "Update job state",
      description: "Move an owned job through in_progress, blocked, completed, or queued retry states with structured outputs.",
      inputSchema: {
        ...jobOwnerSchema,
        state: z.enum(["queued", "in_progress", "blocked", "completed"]),
        note: z.string().optional(),
        blockedReason: z.string().optional(),
        retryAt: z.string().optional(),
        outputs: jobPayloadSchema
      }
    },
    async (input) => {
      const job = await mutateJobs((meta) => transitionJob(meta, input));
      return mcpTextAndStructured(`Job ${job.id} is now ${job.state}.`, { job });
    }
  );

  server.registerTool(
    "retry_stale_jobs",
    {
      title: "Retry stale jobs",
      description: "Recover expired claimed/in-progress leases or block jobs that exhausted attempts.",
      inputSchema: {}
    },
    async () => {
      const jobs = await mutateJobs((meta) => recoverStaleJobs(meta));
      return mcpTextAndStructured(`Recovered ${jobs.length} stale job(s).`, { jobs });
    }
  );

  server.registerTool(
    "register_webhook",
    {
      title: "Register webhook",
      description: "Register an outgoing webhook that fires when matching mailbox messages are created.",
      inputSchema: {
        url: z.url().describe("Public receiver URL to POST events to."),
        name: z.string().optional(),
        event: z.enum(["message.created", "channel.message.created"]).optional(),
        to: z.string().optional().describe("Only deliver messages addressed to this mailbox name."),
        channelId: z.string().optional().describe("Only deliver messages for this channel when event is channel.message.created."),
        secret: z.string().optional().describe("Optional HMAC signing secret. If omitted one is generated.")
      }
    },
    async (input) => {
      const webhook = await createWebhook(input);
      return mcpTextAndStructured(`Registered webhook ${webhook.id}. Save the returned secret for signature verification.`, {
        webhook: { ...publicWebhook(webhook), secret: webhook.secret }
      });
    }
  );

  server.registerTool(
    "list_webhooks",
    {
      title: "List webhooks",
      description: "List registered outgoing webhooks.",
      inputSchema: {}
    },
    async () => {
      const meta = await readMeta();
      const webhooks = (meta.webhooks || []).map(publicWebhook);
      const text = webhooks.length
        ? webhooks.map((webhook) => `${webhook.id} | ${webhook.event} | ${webhook.to || "all"} -> ${webhook.url}`).join("\n")
        : "No webhooks registered.";
      return mcpTextAndStructured(text, { webhooks });
    }
  );

  server.registerTool(
    "delete_webhook",
    {
      title: "Delete webhook",
      description: "Delete a registered webhook.",
      inputSchema: {
        id: z.string().describe("Webhook ID.")
      }
    },
    async ({ id }) => {
      const deleted = await deleteWebhook(id);
      if (!deleted) throw new Error("Webhook not found");
      return mcpTextAndStructured(`Deleted webhook ${id}.`, { id });
    }
  );

  server.registerTool(
    "import_chatgpt_files",
    {
      title: "Import ChatGPT files",
      description: "Import files attached to the current ChatGPT conversation into the private filedrop.",
      inputSchema: {
        openaiFileIdRefs: z.array(z.any()).describe("ChatGPT file reference objects with download_link fields."),
        category: z.string().optional(),
        tags: z.union([z.string(), z.array(z.string())]).optional(),
        note: z.string().optional()
      }
    },
    async ({ openaiFileIdRefs, category, tags, note }) => {
      const files = await importChatGptRefs(openaiFileIdRefs, { category, tags, note }, publicReq);
      return mcpTextAndStructured(`Imported ${files.length} file(s).`, { files });
    }
  );

  server.registerTool(
    "upload_from_url",
    {
      title: "Upload from URL",
      description: "Fetch a file from a URL and save it in the private filedrop.",
      inputSchema: {
        url: z.url().describe("A downloadable URL."),
        name: z.string().optional().describe("Optional stored filename."),
        category: z.string().optional(),
        tags: z.union([z.string(), z.array(z.string())]).optional(),
        note: z.string().optional(),
        project: z.string().optional(),
        path: z.string().optional(),
        commitMessage: z.string().optional()
      }
    },
    async (input) => {
      const file = await saveUrlFileWithMetadata(input, publicReq);
      return mcpTextAndStructured(`Uploaded ${file.name}.`, { file });
    }
  );

  server.registerTool(
    "upload_new_version_from_url",
    {
      title: "Upload new version from URL",
      description: "Fetch a URL and save it as the next version of an existing file.",
      inputSchema: {
        parentId: z.string().describe("Existing file ID to version from."),
        url: z.url().describe("A downloadable URL."),
        name: z.string().optional().describe("Optional stored filename."),
        category: z.string().optional(),
        tags: z.union([z.string(), z.array(z.string())]).optional(),
        note: z.string().optional(),
        project: z.string().optional(),
        path: z.string().optional(),
        commitMessage: z.string().optional()
      }
    },
    async (input) => {
      const file = await saveUrlFileWithMetadata(input, publicReq);
      return mcpTextAndStructured(`Uploaded ${file.name} v${file.version}.`, { file });
    }
  );

  server.registerTool(
    "organize_file",
    {
      title: "Organize file",
      description: "Update a stored file's category, tags, or note.",
      inputSchema: {
        id: z.string().describe("File ID from list_files."),
        category: z.string().optional(),
        tags: z.union([z.string(), z.array(z.string())]).optional(),
        note: z.string().optional(),
        project: z.string().optional(),
        path: z.string().optional(),
        commitMessage: z.string().optional()
      }
    },
    async ({ id, category, tags, note, project, path: filePath, commitMessage }) => {
      const file = await updateFileMetadata(id, { category, tags, note, project, path: filePath, commitMessage });
      if (!file) throw new Error("File not found");
      const publicRecord = publicFile(file, publicReq);
      return mcpTextAndStructured(`Updated ${publicRecord.name}.`, { file: publicRecord });
    }
  );

  server.registerTool(
    "get_file_history",
    {
      title: "Get file history",
      description: "Return the version chain for a stored file.",
      inputSchema: {
        id: z.string().describe("Any file ID in the version chain.")
      }
    },
    async ({ id }) => {
      const meta = await readMeta();
      const history = lineageFor(meta.files, id).map((file) => publicFile(file, publicReq));
      if (!history.length) throw new Error("File not found");
      const text = history.map((file) => `v${file.version} | ${file.uploadedAt} | ${file.commitMessage || file.name}`).join("\n");
      return mcpTextAndStructured(text, { files: history });
    }
  );

  server.registerTool(
    "get_file_link",
    {
      title: "Get file link",
      description: "Get the direct download link and metadata for a stored file.",
      inputSchema: {
        id: z.string().describe("File ID from list_files.")
      }
    },
    async ({ id }) => {
      const meta = await readMeta();
      const file = meta.files.find((item) => item.id === id);
      if (!file) throw new Error("File not found");
      const publicRecord = publicFile(file, publicReq);
      return mcpTextAndStructured(`${publicRecord.name}: ${publicRecord.downloadUrl}`, { file: publicRecord });
    }
  );

  return server;
}

async function handleMcpRequest(req, res) {
  if (!apiKey) {
    res.status(503).json({ error: "API_KEY is not configured" });
    return;
  }
  if (!hasValidApiKey(req)) {
    res.status(401).json({ error: "Invalid API key" });
    return;
  }

  const sessionId = req.headers["mcp-session-id"];
  let transport = sessionId ? mcpTransports[sessionId] : null;
  if (!transport && req.method === "POST" && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (newSessionId) => {
        mcpTransports[newSessionId] = transport;
      }
    });
    transport.onclose = () => {
      if (transport.sessionId) delete mcpTransports[transport.sessionId];
    };
    const server = createMcpServer(req);
    await server.connect(transport);
  }

  if (!transport) {
    res.status(req.method === "GET" ? 405 : 400).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: req.method === "GET" ? "Method Not Allowed" : "Bad Request: No valid MCP session"
      },
      id: null
    });
    return;
  }

  await transport.handleRequest(req, res, req.body);
}

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, storageDriver, storageConfigured: storageConfigured() });
});

app.get(
  "/approvals/api/inbox",
  requireConfiguredSecret(uploadPassword, "UPLOAD_PASSWORD"),
  requireWebPassword,
  async (_req, res, next) => {
    try {
      const meta = await readMeta();
      const events = filterChannelMessages(meta.channelMessages || [], {
        channelId: "teams-approval-monitor"
      })
        .slice(0, 1000)
        .map(publicChannelMessage);
      const messages = filterMessages(meta.messages || [], {
        to: "ashwin-main-codex",
        from: "ashwin-remote-codex"
      })
        .slice(0, 500)
        .map(publicMessage);
      res.json({ events, messages, syncedAt: new Date().toISOString() });
    } catch (error) {
      next(error);
    }
  }
);

app.get(
  "/approvals/api/files/:id",
  requireConfiguredSecret(uploadPassword, "UPLOAD_PASSWORD"),
  requireWebPassword,
  async (req, res, next) => {
    try {
      const meta = await readMeta();
      const file = meta.files.find((item) => item.id === req.params.id);
      if (!file) {
        res.status(404).json({ error: "File not found" });
        return;
      }
      await sendFileObject(res, file);
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  "/approvals/api/approve",
  requireConfiguredSecret(uploadPassword, "UPLOAD_PASSWORD"),
  requireWebPassword,
  async (req, res, next) => {
    try {
      const recipient = cleanText(req.body?.recipient, 120);
      const draft = cleanText(req.body?.draft, 4000);
      const sourceMessageIds = Array.isArray(req.body?.sourceMessageIds)
        ? req.body.sourceMessageIds.map((id) => cleanText(id, 80)).filter(Boolean)
        : [];
      if (!recipient || !draft) {
        res.status(400).json({ error: "Recipient and draft are required" });
        return;
      }
      const message = await createMessage({
        from: "ashwin-main-codex",
        to: "ashwin-remote-codex",
        project: "Mindsight Campaign Implementation",
        category: "APPROVED_SEND",
        tags: ["teams", "approval-desk", "user-approved"],
        body: `User approved in Teams Approval Desk. Send this exact reply to ${recipient} in Teams now:\n\n"${draft}"\n\nReply with exact sent text and timestamp. Source FileDrop messages: ${sourceMessageIds.join(", ") || "none"}`
      });
      res.status(201).json({ ok: true, messageId: message.id });
    } catch (error) {
      next(error);
    }
  }
);

app.post("/mcp", async (req, res, next) => {
  try {
    await handleMcpRequest(req, res);
  } catch (error) {
    next(error);
  }
});

app.get("/mcp", async (req, res, next) => {
  try {
    await handleMcpRequest(req, res);
  } catch (error) {
    next(error);
  }
});

app.delete("/mcp", async (req, res, next) => {
  try {
    await handleMcpRequest(req, res);
  } catch (error) {
    next(error);
  }
});

app.post(
  "/api/upload",
  requireConfiguredSecret(apiKey, "API_KEY"),
  requireApiKey,
  upload.single("file"),
  async (req, res, next) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: "Missing file field" });
        return;
      }
      const record = await saveUploadedFile(req.file, req.body);
      res.status(201).json(publicFile(record, req));
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  "/api/files/:id/versions",
  requireConfiguredSecret(apiKey, "API_KEY"),
  requireApiKey,
  upload.single("file"),
  async (req, res, next) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: "Missing file field" });
        return;
      }
      const record = await saveUploadedFile(req.file, { ...req.body, parentId: req.params.id });
      res.status(201).json(publicFile(record, req));
    } catch (error) {
      next(error);
    }
  }
);

app.post("/api/chatgpt/import", requireConfiguredSecret(apiKey, "API_KEY"), requireApiKey, async (req, res, next) => {
  try {
    const imported = await importChatGptRefs(req.body?.openaiFileIdRefs, req.body, req);
    res.status(201).json({ files: imported });
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/migrate-local-to-s3", requireConfiguredSecret(apiKey, "API_KEY"), requireApiKey, async (req, res, next) => {
  try {
    const result = await migrateLocalStorageToS3(req.body || {});
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post(
  "/web/upload",
  requireConfiguredSecret(uploadPassword, "UPLOAD_PASSWORD"),
  requireWebPassword,
  upload.single("file"),
  async (req, res, next) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: "Missing file field" });
        return;
      }
      const record = await saveUploadedFile(req.file, req.body);
      res.status(201).json(publicFile(record, req));
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  "/web/files/:id/versions",
  requireConfiguredSecret(uploadPassword, "UPLOAD_PASSWORD"),
  requireWebPassword,
  upload.single("file"),
  async (req, res, next) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: "Missing file field" });
        return;
      }
      const record = await saveUploadedFile(req.file, { ...req.body, parentId: req.params.id });
      res.status(201).json(publicFile(record, req));
    } catch (error) {
      next(error);
    }
  }
);

app.get("/api/files", requireConfiguredSecret(apiKey, "API_KEY"), requireApiKey, async (req, res, next) => {
  try {
    const meta = await readMeta();
    const sourceFiles = req.query.latest === "true" ? latestFiles(meta.files) : meta.files;
    res.json({ files: sourceFiles.map((file) => publicFile(file, req)) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects", requireConfiguredSecret(apiKey, "API_KEY"), requireApiKey, async (req, res, next) => {
  try {
    const meta = await readMeta();
    res.json({ projects: projectSummary(meta.files) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/channels", requireConfiguredSecret(apiKey, "API_KEY"), requireApiKey, async (_req, res, next) => {
  try {
    const meta = await readMeta();
    res.json({ channels: (meta.channels || []).map(publicChannel) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/channels", requireConfiguredSecret(apiKey, "API_KEY"), requireApiKey, async (req, res, next) => {
  try {
    const channel = await upsertChannel(req.body);
    res.status(201).json(publicChannel(channel));
  } catch (error) {
    next(error);
  }
});

app.get("/api/channels/:channelId/messages", requireConfiguredSecret(apiKey, "API_KEY"), requireApiKey, async (req, res, next) => {
  try {
    const meta = await readMeta();
    const messages = filterChannelMessages(meta.channelMessages || [], {
      channelId: req.params.channelId,
      from: cleanText(req.query.from, 80),
      since: cleanText(req.query.since, 80),
      unreadOnly: req.query.unreadOnly === "true",
      category: cleanText(req.query.category, 80),
      tag: cleanText(req.query.tag, 40)
    }).map(publicChannelMessage);
    res.json({ messages });
  } catch (error) {
    next(error);
  }
});

app.post("/api/channels/:channelId/messages", requireConfiguredSecret(apiKey, "API_KEY"), requireApiKey, async (req, res, next) => {
  try {
    const message = await createChannelMessage(req.params.channelId, req.body);
    res.status(201).json(publicChannelMessage(message));
  } catch (error) {
    next(error);
  }
});

app.patch("/api/channels/:channelId/messages/:id/read", requireConfiguredSecret(apiKey, "API_KEY"), requireApiKey, async (req, res, next) => {
  try {
    const message = await markChannelMessageRead(req.params.channelId, req.params.id);
    if (!message) {
      res.status(404).json({ error: "Channel message not found" });
      return;
    }
    res.json(publicChannelMessage(message));
  } catch (error) {
    next(error);
  }
});

app.get("/api/messages", requireConfiguredSecret(apiKey, "API_KEY"), requireApiKey, async (req, res, next) => {
  try {
    const meta = await readMeta();
    const messages = filterMessages(meta.messages || [], {
      to: cleanText(req.query.to, 80),
      from: cleanText(req.query.from, 80),
      project: cleanText(req.query.project, 120),
      category: cleanText(req.query.category, 80),
      tag: cleanText(req.query.tag, 40),
      since: cleanText(req.query.since, 80),
      unreadOnly: req.query.unreadOnly === "true"
    }).map(publicMessage);
    res.json({ messages });
  } catch (error) {
    next(error);
  }
});

app.post("/api/messages", requireConfiguredSecret(apiKey, "API_KEY"), requireApiKey, async (req, res, next) => {
  try {
    const message = await createMessage(req.body);
    res.status(201).json(publicMessage(message));
  } catch (error) {
    next(error);
  }
});

app.patch("/api/messages/:id/read", requireConfiguredSecret(apiKey, "API_KEY"), requireApiKey, async (req, res, next) => {
  try {
    const message = await markMessageRead(req.params.id);
    if (!message) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    res.json(publicMessage(message));
  } catch (error) {
    next(error);
  }
});

app.get("/api/jobs", requireConfiguredSecret(apiKey, "API_KEY"), requireApiKey, async (req, res, next) => {
  try {
    const meta = await readMeta();
    res.json({ jobs: listJobs(meta, {
      state: cleanText(req.query.state, 40),
      device: cleanText(req.query.device, 200),
      project: cleanText(req.query.project, 200),
      kind: cleanText(req.query.kind, 120)
    }) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/jobs/:id", requireConfiguredSecret(apiKey, "API_KEY"), requireApiKey, async (req, res, next) => {
  try {
    const meta = await readMeta();
    const job = listJobs(meta).find((candidate) => candidate.id === req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found" });
    res.json({ job });
  } catch (error) {
    next(error);
  }
});

app.post("/api/jobs", requireConfiguredSecret(apiKey, "API_KEY"), requireApiKey, async (req, res, next) => {
  try {
    const result = await mutateJobs((meta) => enqueueJob(meta, req.body));
    res.status(result.created ? 201 : 200).json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/jobs/claim", requireConfiguredSecret(apiKey, "API_KEY"), requireApiKey, async (req, res, next) => {
  try {
    const job = await mutateJobs((meta) => claimJob(meta, req.body));
    res.status(job ? 200 : 204).json(job ? { job } : undefined);
  } catch (error) {
    next(error);
  }
});

app.post("/api/jobs/retry-stale", requireConfiguredSecret(apiKey, "API_KEY"), requireApiKey, async (_req, res, next) => {
  try {
    const jobs = await mutateJobs((meta) => recoverStaleJobs(meta));
    res.json({ jobs });
  } catch (error) {
    next(error);
  }
});

app.post("/api/jobs/:id/heartbeat", requireConfiguredSecret(apiKey, "API_KEY"), requireApiKey, async (req, res, next) => {
  try {
    const job = await mutateJobs((meta) => heartbeatJob(meta, { ...req.body, id: req.params.id }));
    res.json({ job });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/jobs/:id", requireConfiguredSecret(apiKey, "API_KEY"), requireApiKey, async (req, res, next) => {
  try {
    const job = await mutateJobs((meta) => transitionJob(meta, { ...req.body, id: req.params.id }));
    res.json({ job });
  } catch (error) {
    next(error);
  }
});

app.post("/api/telegram/job-approval", async (req, res, next) => {
  try {
    if (!telegramApprovalSecret) {
      res.status(503).json({ error: "TELEGRAM_APPROVAL_WEBHOOK_SECRET is not configured" });
      return;
    }
    if (!hasValidTelegramApprovalSecret(req)) {
      res.status(401).json({ error: "Invalid Telegram webhook secret" });
      return;
    }
    const callback = req.body?.callback_query;
    const match = String(callback?.data || "").match(/^(APPROVE|REJECT):([A-Za-z0-9._:-]+)$/);
    const chatId = String(callback?.message?.chat?.id || "");
    if (!match || (telegramApprovalChatId && chatId !== telegramApprovalChatId)) {
      res.status(200).json({ ok: true, ignored: true });
      return;
    }
    const [, decision, approvalId] = match;
    const event = {
      approvalId,
      decision,
      decidedAt: new Date().toISOString(),
      telegramUpdateId: req.body.update_id,
      source: "telegram-webhook"
    };
    const message = await createMessage({
      from: "telegram",
      to: "job-approval-worker",
      body: JSON.stringify(event),
      project: "Job Finder",
      category: "job-approval",
      tags: ["telegram", "approval", decision.toLowerCase()]
    });
    res.status(200).json({ ok: true, messageId: message.id });
    acknowledgeTelegramApproval(callback, decision, approvalId).catch((error) => console.error("Telegram acknowledgement failed", error));
  } catch (error) {
    next(error);
  }
});

app.get("/api/webhooks", requireConfiguredSecret(apiKey, "API_KEY"), requireApiKey, async (_req, res, next) => {
  try {
    const meta = await readMeta();
    res.json({ webhooks: (meta.webhooks || []).map(publicWebhook) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/webhooks", requireConfiguredSecret(apiKey, "API_KEY"), requireApiKey, async (req, res, next) => {
  try {
    const webhook = await createWebhook(req.body);
    res.status(201).json({ ...publicWebhook(webhook), secret: webhook.secret });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/webhooks/:id", requireConfiguredSecret(apiKey, "API_KEY"), requireApiKey, async (req, res, next) => {
  try {
    const deleted = await deleteWebhook(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: "Webhook not found" });
      return;
    }
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

app.post("/api/webhooks/:id/test", requireConfiguredSecret(apiKey, "API_KEY"), requireApiKey, async (req, res, next) => {
  try {
    const meta = await readMeta();
    const webhook = (meta.webhooks || []).find((item) => item.id === req.params.id);
    if (!webhook) {
      res.status(404).json({ error: "Webhook not found" });
      return;
    }
    if ((webhook.event || "message.created") === "channel.message.created") {
      await deliverWebhook(webhook, "channel.message.created", {
        channel: { id: webhook.channelId || "test", name: webhook.channelId || "test" },
        message: {
          id: "test",
          channelId: webhook.channelId || "test",
          from: "filedrop",
          body: "Test channel webhook delivery",
          createdAt: new Date().toISOString(),
          category: "test",
          tags: ["test"],
          relatedFileId: "",
          relatedUrl: "",
          readAt: ""
        }
      });
    } else {
      await deliverWebhook(webhook, "message.created", {
        message: {
          id: "test",
          from: "filedrop",
          to: webhook.to || "all",
          body: "Test webhook delivery",
          createdAt: new Date().toISOString(),
          project: "Comms",
          category: "test",
          tags: ["test"],
          relatedFileId: "",
          relatedUrl: "",
          readAt: ""
        }
      });
    }
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/files/:id/history", requireConfiguredSecret(apiKey, "API_KEY"), requireApiKey, async (req, res, next) => {
  try {
    const meta = await readMeta();
    const history = lineageFor(meta.files, req.params.id);
    if (!history.length) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    res.json({ files: history.map((file) => publicFile(file, req)) });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/files/:id", requireConfiguredSecret(apiKey, "API_KEY"), requireApiKey, async (req, res, next) => {
  try {
    const file = await updateFileMetadata(req.params.id, req.body);
    if (!file) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    res.json(publicFile(file, req));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/files/:id", requireConfiguredSecret(apiKey, "API_KEY"), requireApiKey, async (req, res, next) => {
  try {
    const meta = await readMeta();
    const index = (meta.files || []).findIndex((item) => item.id === req.params.id);
    if (index === -1) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    const [file] = meta.files.splice(index, 1);
    await deleteFileObject(file.storageName);
    await writeMeta(meta);
    res.json({ deleted: publicFile(file, req) });
  } catch (error) {
    next(error);
  }
});

app.get("/web/files", requireConfiguredSecret(uploadPassword, "UPLOAD_PASSWORD"), requireWebPassword, async (req, res, next) => {
  try {
    const meta = await readMeta();
    const sourceFiles = req.query.latest === "true" ? latestFiles(meta.files) : meta.files;
    res.json({ files: sourceFiles.map((file) => publicFile(file, req)) });
  } catch (error) {
    next(error);
  }
});

app.get("/web/projects", requireConfiguredSecret(uploadPassword, "UPLOAD_PASSWORD"), requireWebPassword, async (req, res, next) => {
  try {
    const meta = await readMeta();
    res.json({ projects: projectSummary(meta.files) });
  } catch (error) {
    next(error);
  }
});

app.get("/web/messages", requireConfiguredSecret(uploadPassword, "UPLOAD_PASSWORD"), requireWebPassword, async (req, res, next) => {
  try {
    const meta = await readMeta();
    const messages = filterMessages(meta.messages || [], {
      to: cleanText(req.query.to, 80),
      from: cleanText(req.query.from, 80),
      since: cleanText(req.query.since, 80),
      unreadOnly: req.query.unreadOnly === "true"
    }).map(publicMessage);
    res.json({ messages });
  } catch (error) {
    next(error);
  }
});

app.post("/web/messages", requireConfiguredSecret(uploadPassword, "UPLOAD_PASSWORD"), requireWebPassword, async (req, res, next) => {
  try {
    const message = await createMessage(req.body);
    res.status(201).json(publicMessage(message));
  } catch (error) {
    next(error);
  }
});

app.patch("/web/messages/:id/read", requireConfiguredSecret(uploadPassword, "UPLOAD_PASSWORD"), requireWebPassword, async (req, res, next) => {
  try {
    const message = await markMessageRead(req.params.id);
    if (!message) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    res.json(publicMessage(message));
  } catch (error) {
    next(error);
  }
});

app.get("/web/files/:id/history", requireConfiguredSecret(uploadPassword, "UPLOAD_PASSWORD"), requireWebPassword, async (req, res, next) => {
  try {
    const meta = await readMeta();
    const history = lineageFor(meta.files, req.params.id);
    if (!history.length) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    res.json({ files: history.map((file) => publicFile(file, req)) });
  } catch (error) {
    next(error);
  }
});

app.patch("/web/files/:id", requireConfiguredSecret(uploadPassword, "UPLOAD_PASSWORD"), requireWebPassword, async (req, res, next) => {
  try {
    const file = await updateFileMetadata(req.params.id, req.body);
    if (!file) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    res.json(publicFile(file, req));
  } catch (error) {
    next(error);
  }
});

app.get("/api/files/:id/download", requireConfiguredSecret(apiKey, "API_KEY"), requireApiKey, async (req, res, next) => {
  try {
    const meta = await readMeta();
    const file = meta.files.find((item) => item.id === req.params.id);
    if (!file) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    await sendFileObject(res, file);
  } catch (error) {
    next(error);
  }
});

app.get("/api/files/:id/chatgpt-return", requireConfiguredSecret(apiKey, "API_KEY"), requireApiKey, async (req, res, next) => {
  try {
    const meta = await readMeta();
    const file = meta.files.find((item) => item.id === req.params.id);
    if (!file) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    res.json({ openaiFileResponse: [publicFile(file, req).downloadUrl] });
  } catch (error) {
    next(error);
  }
});

app.get("/d/:token", async (req, res, next) => {
  try {
    const meta = await readMeta();
    const file = meta.files.find((item) => item.downloadToken === req.params.token);
    if (!file) {
      res.status(404).send("File not found");
      return;
    }
    await sendFileObject(res, file);
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  if (error.statusCode) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }
  if (error.code === "LIMIT_FILE_SIZE") {
    res.status(413).json({ error: `File is larger than ${maxUploadMb} MB` });
    return;
  }
  console.error(error);
  res.status(500).json({ error: "Unexpected server error" });
});

app.listen(port, host, () => {
  console.log(`Filedrop listening on ${host || "0.0.0.0"}:${port}`);
});
