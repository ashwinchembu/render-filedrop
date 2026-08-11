import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const configPath = path.join(os.homedir(), "Library", "Application Support", "FileDrop", "filedrop.json");
const cacheRoot = path.join(os.homedir(), "Library", "Application Support", "FileDrop", "message-cache");
const config = JSON.parse(await fs.readFile(configPath, "utf8"));
const baseUrl = config.baseUrl || "https://private-filedrop.onrender.com";
if (!config.apiKey) throw new Error("FileDrop API key is missing from the protected local configuration.");

const headers = { authorization: `Bearer ${config.apiKey}` };
const intervalMs = Math.max(15_000, Number(process.env.FILEDROP_CACHE_INTERVAL_MS || 30_000));
const watch = process.argv.includes("--watch");

async function atomicJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2));
  await fs.rename(temp, filePath);
}

async function readJson(filePath, fallback) {
  try { return JSON.parse(await fs.readFile(filePath, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}

async function fetchJson(route) {
  const response = await fetch(`${baseUrl}${route}`, { headers });
  if (!response.ok) throw new Error(`${route} returned ${response.status}`);
  return response.json();
}

async function syncCollection(name, route, property) {
  const collectionRoot = path.join(cacheRoot, name);
  const checkpointPath = path.join(collectionRoot, "checkpoint.json");
  const indexPath = path.join(collectionRoot, "index.json");
  const checkpoint = await readJson(checkpointPath, { since: "" });
  const separator = route.includes("?") ? "&" : "?";
  const payload = await fetchJson(`${route}${checkpoint.since ? `${separator}since=${encodeURIComponent(checkpoint.since)}` : ""}`);
  const records = Array.isArray(payload[property]) ? payload[property] : [];
  const existingIndex = await readJson(indexPath, []);
  const byId = new Map(existingIndex.map((item) => [item.id, item]));
  for (const record of records) {
    await atomicJson(path.join(collectionRoot, "records", `${record.id}.json`), record);
    byId.set(record.id, { id: record.id, createdAt: record.createdAt, from: record.from || "", to: record.to || "", channelId: record.channelId || "", project: record.project || "", category: record.category || "", readAt: record.readAt || "" });
  }
  const index = [...byId.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  await atomicJson(indexPath, index);
  const newest = records.reduce((value, item) => !value || item.createdAt > value ? item.createdAt : value, checkpoint.since);
  await atomicJson(checkpointPath, { since: newest || "", syncedAt: new Date().toISOString(), records: index.length });
  return { name, received: records.length, cached: index.length };
}

async function syncOnce() {
  const results = await Promise.all([
    syncCollection("mailbox", "/api/messages?to=ashwin-main-codex", "messages"),
    syncCollection("teams-approval-monitor", "/api/channels/teams-approval-monitor/messages", "messages"),
    syncCollection("teams-attachment-worker", "/api/channels/teams-attachment-worker/messages", "messages")
  ]);
  await atomicJson(path.join(cacheRoot, "status.json"), { ok: true, syncedAt: new Date().toISOString(), collections: results });
  return results;
}

do {
  try { console.log(JSON.stringify(await syncOnce())); }
  catch (error) {
    await atomicJson(path.join(cacheRoot, "status.json"), { ok: false, failedAt: new Date().toISOString(), error: error.message });
    console.error(error.message);
  }
  if (watch) await new Promise((resolve) => setTimeout(resolve, intervalMs));
} while (watch);
