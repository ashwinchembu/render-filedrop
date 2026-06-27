import fs from "node:fs/promises";
import path from "node:path";
import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";

const storageDir = process.env.STORAGE_DIR || path.resolve("data");
const filesDir = path.join(storageDir, "files");
const metadataPath = path.join(storageDir, "metadata.json");
const bucket = process.env.S3_BUCKET || "";
const prefix = (process.env.S3_PREFIX || "filedrop").replace(/^\/+|\/+$/g, "");
const region = process.env.S3_REGION || "us-east-1";
const endpoint = process.env.S3_ENDPOINT || undefined;
const forcePathStyle = process.env.S3_FORCE_PATH_STYLE === "true";
const dryRun = process.argv.includes("--dry-run");

if (!bucket) {
  console.error("S3_BUCKET is required.");
  process.exit(1);
}

const s3 = new S3Client({ region, endpoint, forcePathStyle });

function key(name) {
  return prefix ? `${prefix}/${name}` : name;
}

async function exists(objectKey) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }));
    return true;
  } catch (error) {
    if (error.name === "NotFound" || error.$metadata?.httpStatusCode === 404) {
      return false;
    }
    throw error;
  }
}

async function put(objectKey, body, contentType) {
  if (dryRun) {
    console.log(`[dry-run] upload s3://${bucket}/${objectKey}`);
    return;
  }
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      Body: body,
      ContentType: contentType
    })
  );
  console.log(`uploaded s3://${bucket}/${objectKey}`);
}

async function main() {
  const metadataBytes = await fs.readFile(metadataPath);
  const metadata = JSON.parse(metadataBytes.toString("utf8"));
  const files = Array.isArray(metadata.files) ? metadata.files : [];

  console.log(`source metadata: ${metadataPath}`);
  console.log(`target bucket: s3://${bucket}/${prefix || ""}`);
  console.log(`file records: ${files.length}`);

  for (const file of files) {
    if (!file.storageName) continue;
    const sourcePath = path.join(filesDir, file.storageName);
    const objectKey = key(`files/${file.storageName}`);
    const alreadyUploaded = await exists(objectKey);
    if (alreadyUploaded) {
      console.log(`exists s3://${bucket}/${objectKey}`);
      continue;
    }
    const bytes = await fs.readFile(sourcePath);
    await put(objectKey, bytes, file.mimeType || "application/octet-stream");
  }

  await put(key("metadata.json"), metadataBytes, "application/json");
  console.log("migration complete");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
