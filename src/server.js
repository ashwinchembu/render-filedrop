import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import helmet from "helmet";
import multer from "multer";

const app = express();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST;
const storageDir = process.env.STORAGE_DIR || path.resolve("data");
const uploadPassword = process.env.UPLOAD_PASSWORD || "";
const apiKey = process.env.API_KEY || "";
const maxUploadMb = Number(process.env.MAX_UPLOAD_MB || 250);

const filesDir = path.join(storageDir, "files");
const metaPath = path.join(storageDir, "metadata.json");

await fs.mkdir(filesDir, { recursive: true });

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
  storage: multer.diskStorage({
    destination: filesDir,
    filename: (_req, file, cb) => {
      const id = crypto.randomUUID();
      const safeExt = path.extname(file.originalname).replace(/[^a-zA-Z0-9.]/g, "");
      cb(null, `${id}${safeExt}`);
    }
  }),
  limits: { fileSize: maxUploadMb * 1024 * 1024 }
});

async function readMeta() {
  try {
    return JSON.parse(await fs.readFile(metaPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { files: [] };
    throw error;
  }
}

async function writeMeta(meta) {
  const tempPath = `${metaPath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(meta, null, 2));
  await fs.rename(tempPath, metaPath);
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
  const meta = await readMeta();
  const record = {
    id: crypto.randomUUID(),
    storageName: file.filename,
    originalName: label || file.originalname,
    mimeType: file.mimetype || "application/octet-stream",
    size: file.size,
    uploadedAt: new Date().toISOString(),
    downloadToken: crypto.randomBytes(24).toString("base64url")
  };
  meta.files.unshift(record);
  await writeMeta(meta);
  return record;
}

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
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
    res.download(path.join(filesDir, file.storageName), file.originalName);
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
    res.download(path.join(filesDir, file.storageName), file.originalName);
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
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
