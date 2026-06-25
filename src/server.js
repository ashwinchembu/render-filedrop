import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import express from "express";
import helmet from "helmet";
import multer from "multer";

const app = express();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST;
const storageDir = process.env.STORAGE_DIR || path.resolve("data");
const storageDriver = process.env.STORAGE_DRIVER || "local";
const uploadPassword = process.env.UPLOAD_PASSWORD || "";
const apiKey = process.env.API_KEY || "";
const maxUploadMb = Number(process.env.MAX_UPLOAD_MB || 250);
const s3Bucket = process.env.S3_BUCKET || "";
const s3Prefix = (process.env.S3_PREFIX || "filedrop").replace(/^\/+|\/+$/g, "");
const s3Region = process.env.S3_REGION || "us-east-1";
const s3Endpoint = process.env.S3_ENDPOINT || undefined;
const s3ForcePathStyle = process.env.S3_FORCE_PATH_STYLE === "true";

const filesDir = path.join(storageDir, "files");
const metaPath = path.join(storageDir, "metadata.json");

const s3 =
  storageDriver === "s3"
    ? new S3Client({
        region: s3Region,
        endpoint: s3Endpoint,
        forcePathStyle: s3ForcePathStyle
      })
    : null;

if (storageDriver === "local") {
  await fs.mkdir(filesDir, { recursive: true });
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
  const auth = req.header("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : req.header("x-api-key");
  const provided = Buffer.from(token || "");
  const expected = Buffer.from(apiKey);
  if (provided.length === expected.length && crypto.timingSafeEqual(provided, expected)) {
    next();
    return;
  }
  res.status(401).json({ error: "Invalid API key" });
}

function publicFile(file, req) {
  return {
    id: file.id,
    name: file.originalName,
    size: file.size,
    mimeType: file.mimeType,
    uploadedAt: file.uploadedAt,
    downloadUrl: `${req.protocol}://${req.get("host")}/d/${file.downloadToken}`
  };
}

async function saveUploadedFile(file, label) {
  if (!storageConfigured()) {
    const error = new Error("Storage is not configured");
    error.statusCode = 503;
    throw error;
  }

  const meta = await readMeta();
  const safeExt = path.extname(file.originalname).replace(/[^a-zA-Z0-9.]/g, "");
  const record = {
    id: crypto.randomUUID(),
    storageName: `${crypto.randomUUID()}${safeExt}`,
    originalName: label || file.originalname,
    mimeType: file.mimetype || "application/octet-stream",
    size: file.size,
    uploadedAt: new Date().toISOString(),
    downloadToken: crypto.randomBytes(24).toString("base64url")
  };
  await writeFileObject(record.storageName, file);
  meta.files.unshift(record);
  await writeMeta(meta);
  return record;
}

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, storageDriver, storageConfigured: storageConfigured() });
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
      const record = await saveUploadedFile(req.file, req.body?.name);
      res.status(201).json(publicFile(record, req));
    } catch (error) {
      next(error);
    }
  }
);

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
      const record = await saveUploadedFile(req.file, req.body?.name);
      res.status(201).json(publicFile(record, req));
    } catch (error) {
      next(error);
    }
  }
);

app.get("/api/files", requireConfiguredSecret(apiKey, "API_KEY"), requireApiKey, async (req, res, next) => {
  try {
    const meta = await readMeta();
    res.json({ files: meta.files.map((file) => publicFile(file, req)) });
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
