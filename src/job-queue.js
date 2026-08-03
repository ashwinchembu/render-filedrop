import crypto from "node:crypto";

export const JOB_STATES = ["queued", "claimed", "in_progress", "blocked", "completed"];
export const DEVICE_IDS = ["ashwin-main-codex", "ashwin-mac-mini-codex", "ashwin-remote-codex"];

const DEVICE_ALIASES = new Map([
  ["ashwin-main-codex", "ashwin-main-codex"],
  ["main-codex", "ashwin-main-codex"],
  ["macbook-codex", "ashwin-main-codex"],
  ["ashwin-macbook-codex", "ashwin-main-codex"],
  ["ashwin-mac-mini-codex", "ashwin-mac-mini-codex"],
  ["mac-mini-codex", "ashwin-mac-mini-codex"],
  ["macmini-codex", "ashwin-mac-mini-codex"],
  ["ashwin-remote-codex", "ashwin-remote-codex"],
  ["remote-codex", "ashwin-remote-codex"]
]);

const TERMINAL_STATES = new Set(["completed"]);
const TRANSITIONS = {
  queued: new Set(["claimed"]),
  claimed: new Set(["queued", "in_progress"]),
  in_progress: new Set(["queued", "blocked", "completed"]),
  blocked: new Set(["queued", "completed"]),
  completed: new Set()
};
const SECRET_KEY_PATTERN = /(password|passphrase|token|secret|credential|cookie|authorization|api[_-]?key|private[_-]?key|otp|2fa)/i;

function iso(now = new Date()) {
  return now.toISOString();
}

function clean(value, max = 500) {
  return String(value || "").trim().slice(0, max);
}

export function canonicalDeviceId(value, { required = true } = {}) {
  const supplied = clean(value, 200).toLowerCase();
  if (!supplied && !required) return "";
  const canonical = DEVICE_ALIASES.get(supplied);
  if (!canonical) {
    const error = new Error(`Unknown device identity. Use one of: ${DEVICE_IDS.join(", ")}`);
    error.statusCode = 400;
    throw error;
  }
  return canonical;
}

function positiveInteger(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function assertNoSecrets(value, path = "payload") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecrets(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      const error = new Error(`Credentials are not allowed in job payloads (${path}.${key})`);
      error.statusCode = 400;
      throw error;
    }
    assertNoSecrets(child, `${path}.${key}`);
  }
}

function normalizeArtifacts(value = {}) {
  assertNoSecrets(value, "outputs");
  const normalizeList = (items, type) =>
    (Array.isArray(items) ? items : []).slice(0, 100).map((item) => ({
      id: clean(item?.id, 160),
      type,
      label: clean(item?.label, 240),
      url: clean(item?.url, 2000),
      fileId: clean(item?.fileId, 160),
      path: clean(item?.path, 1000),
      mimeType: clean(item?.mimeType, 160),
      checksum: clean(item?.checksum, 200),
      createdAt: clean(item?.createdAt, 80)
    }));
  return {
    status: clean(value.status, 1000),
    links: normalizeList(value.links, "link"),
    files: normalizeList(value.files, "file"),
    screenshots: normalizeList(value.screenshots, "screenshot"),
    data: value.data && typeof value.data === "object" ? value.data : {}
  };
}

function event(state, actor, at, note = "") {
  return { state, actor: clean(actor, 240), at, note: clean(note, 1000) };
}

export function ensureJobStore(meta = {}) {
  meta.jobs ||= [];
  return meta.jobs;
}

export function enqueueJob(meta, input = {}, now = new Date()) {
  const jobs = ensureJobStore(meta);
  const durableId = clean(input.id || input.jobId, 160);
  const dedupeKey = clean(input.dedupeKey || durableId, 240);
  if (!dedupeKey) {
    const error = new Error("dedupeKey or durable job id is required");
    error.statusCode = 400;
    throw error;
  }
  assertNoSecrets(input.payload || {}, "payload");
  const payload = input.payload && typeof input.payload === "object" ? structuredClone(input.payload) : {};
  if (payload.targetDevice) payload.targetDevice = canonicalDeviceId(payload.targetDevice);
  const existing = jobs.find((job) => job.id === durableId || job.dedupeKey === dedupeKey);
  if (existing) return { job: existing, created: false };

  const at = iso(now);
  const id = durableId || `job-${crypto.randomUUID()}`;
  const job = {
    id,
    dedupeKey,
    title: clean(input.title, 300) || id,
    kind: clean(input.kind, 120) || "task",
    project: clean(input.project, 200),
    priority: Math.max(0, Math.min(100, Number(input.priority) || 0)),
    state: "queued",
    payload,
    assignedDevice: "",
    assignedSession: "",
    lease: { claimedAt: "", heartbeatAt: "", expiresAt: "", seconds: 0 },
    attempts: 0,
    maxAttempts: positiveInteger(input.maxAttempts, 3, 20),
    staleAfterSeconds: positiveInteger(input.staleAfterSeconds, 300, 86400),
    retryAt: "",
    blockedReason: "",
    outputs: normalizeArtifacts(),
    transitions: [event("queued", clean(input.createdBy, 240) || "queue", at, "enqueued")],
    createdAt: at,
    updatedAt: at,
    completedAt: ""
  };
  jobs.push(job);
  return { job, created: true };
}

export function recoverStaleJobs(meta, now = new Date()) {
  const jobs = ensureJobStore(meta);
  const at = iso(now);
  const recovered = [];
  for (const job of jobs) {
    if (!["claimed", "in_progress"].includes(job.state)) continue;
    const expiry = Date.parse(job.lease?.expiresAt || "");
    if (!Number.isFinite(expiry) || expiry > now.getTime()) continue;
    if (job.attempts >= job.maxAttempts) {
      job.state = "blocked";
      job.blockedReason = "lease expired and maximum attempts reached";
      job.transitions.push(event("blocked", "queue-reaper", at, job.blockedReason));
    } else {
      job.state = "queued";
      job.retryAt = at;
      job.transitions.push(event("queued", "queue-reaper", at, "stale lease recovered"));
    }
    job.assignedDevice = "";
    job.assignedSession = "";
    job.lease = { claimedAt: "", heartbeatAt: "", expiresAt: "", seconds: 0 };
    job.updatedAt = at;
    recovered.push(job);
  }
  return recovered;
}

export function claimJob(meta, input = {}, now = new Date()) {
  recoverStaleJobs(meta, now);
  const jobs = ensureJobStore(meta);
  const device = canonicalDeviceId(input.device);
  const session = clean(input.session, 240);
  if (!device || !session) {
    const error = new Error("device and session are required to claim a job");
    error.statusCode = 400;
    throw error;
  }
  const requestedId = clean(input.id || input.jobId, 160);
  const eligible = jobs
    .filter((job) => job.state === "queued" && (!job.retryAt || job.retryAt <= iso(now)))
    .filter((job) => !requestedId || job.id === requestedId)
    .filter((job) => !input.kind || job.kind === input.kind)
    .filter((job) => !input.project || job.project === input.project)
    .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
  const job = eligible[0];
  if (!job) return null;
  const leaseSeconds = positiveInteger(input.leaseSeconds, job.staleAfterSeconds, 86400);
  const at = iso(now);
  job.state = "claimed";
  job.assignedDevice = device;
  job.assignedSession = session;
  job.attempts += 1;
  job.retryAt = "";
  job.lease = {
    claimedAt: at,
    heartbeatAt: at,
    expiresAt: iso(new Date(now.getTime() + leaseSeconds * 1000)),
    seconds: leaseSeconds
  };
  job.transitions.push(event("claimed", `${device}/${session}`, at, `attempt ${job.attempts}`));
  job.updatedAt = at;
  return job;
}

function ownedJob(meta, input) {
  const job = ensureJobStore(meta).find((candidate) => candidate.id === clean(input.id || input.jobId, 160));
  if (!job) {
    const error = new Error("Job not found");
    error.statusCode = 404;
    throw error;
  }
  if (TERMINAL_STATES.has(job.state)) {
    const error = new Error("Completed jobs are terminal");
    error.statusCode = 409;
    throw error;
  }
  const device = canonicalDeviceId(input.device);
  if (job.assignedDevice && (job.assignedDevice !== device || job.assignedSession !== clean(input.session, 240))) {
    const error = new Error("Job is owned by another device/session");
    error.statusCode = 409;
    throw error;
  }
  return job;
}

export function heartbeatJob(meta, input = {}, now = new Date()) {
  const job = ownedJob(meta, input);
  if (!["claimed", "in_progress"].includes(job.state)) {
    const error = new Error("Only claimed or in-progress jobs accept heartbeats");
    error.statusCode = 409;
    throw error;
  }
  const at = iso(now);
  const seconds = positiveInteger(input.leaseSeconds, job.lease.seconds || job.staleAfterSeconds, 86400);
  job.lease.heartbeatAt = at;
  job.lease.expiresAt = iso(new Date(now.getTime() + seconds * 1000));
  job.lease.seconds = seconds;
  job.updatedAt = at;
  return job;
}

export function transitionJob(meta, input = {}, now = new Date()) {
  const job = ownedJob(meta, input);
  const next = clean(input.state, 40);
  if (!JOB_STATES.includes(next) || !TRANSITIONS[job.state].has(next)) {
    const error = new Error(`Invalid job transition: ${job.state} -> ${next}`);
    error.statusCode = 409;
    throw error;
  }
  const at = iso(now);
  job.state = next;
  job.outputs = input.outputs ? normalizeArtifacts(input.outputs) : job.outputs;
  job.blockedReason = next === "blocked" ? clean(input.blockedReason, 2000) : "";
  job.transitions.push(event(next, `${canonicalDeviceId(input.device)}/${clean(input.session, 240)}`, at, input.note || job.blockedReason));
  job.updatedAt = at;
  if (next === "queued") {
    job.retryAt = clean(input.retryAt, 80) || at;
    job.assignedDevice = "";
    job.assignedSession = "";
    job.lease = { claimedAt: "", heartbeatAt: "", expiresAt: "", seconds: 0 };
  }
  if (next === "completed") {
    job.completedAt = at;
    job.lease.expiresAt = at;
  }
  return job;
}

export function listJobs(meta, filters = {}) {
  return ensureJobStore(meta)
    .filter((job) => !filters.state || job.state === filters.state)
    .filter((job) => !filters.device || job.assignedDevice === filters.device)
    .filter((job) => !filters.project || job.project === filters.project)
    .filter((job) => !filters.kind || job.kind === filters.kind)
    .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
}
