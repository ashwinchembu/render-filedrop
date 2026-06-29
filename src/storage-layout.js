export function normalizeStoragePrefix(value) {
  return String(value || "filedrop").replace(/^\/+|\/+$/g, "");
}

export function storageObjectKey(prefix, name) {
  return prefix ? `${prefix}/${name}` : name;
}

function objectBody(value) {
  return JSON.stringify(value, null, 2);
}

function safePathSegment(value) {
  return (
    String(value || "unknown")
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || "unknown"
  );
}

function summarizeProjects(files = []) {
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

function pushJson(objects, key, value) {
  objects.push({
    key,
    body: objectBody(value),
    contentType: "application/json"
  });
}

export function buildOrganizedMetadataObjects(metadata = {}, { generatedAt = new Date().toISOString() } = {}) {
  const files = Array.isArray(metadata.files) ? metadata.files : [];
  const messages = Array.isArray(metadata.messages) ? metadata.messages : [];
  const channels = Array.isArray(metadata.channels) ? metadata.channels : [];
  const channelMessages = Array.isArray(metadata.channelMessages) ? metadata.channelMessages : [];
  const webhooks = Array.isArray(metadata.webhooks) ? metadata.webhooks : [];
  const objects = [];

  pushJson(objects, "manifests/storage-layout.json", {
    generatedAt,
    version: 1,
    canonical: {
      metadata: "metadata.json",
      fileObjects: "files/{storageName}"
    },
    mirrors: {
      fullState: "state/metadata.json",
      files: "indexes/files.json",
      projects: "indexes/projects.json",
      mailbox: "mailbox/messages.json",
      mailboxUnread: "mailbox/unread.json",
      mailboxByRecipient: "mailbox/by-recipient/{recipient}.json",
      channels: "channels/channels.json",
      channelMessages: "channels/messages.json",
      channelMessagesByChannel: "channels/by-channel/{channelId}.json",
      webhooks: "webhooks/webhooks.json"
    }
  });
  pushJson(objects, "state/metadata.json", metadata);
  pushJson(objects, "indexes/files.json", files);
  pushJson(objects, "indexes/projects.json", summarizeProjects(files));
  pushJson(objects, "mailbox/messages.json", messages);
  pushJson(objects, "mailbox/unread.json", messages.filter((message) => !message.readAt));
  pushJson(objects, "channels/channels.json", channels);
  pushJson(objects, "channels/messages.json", channelMessages);
  pushJson(objects, "webhooks/webhooks.json", webhooks);

  const recipients = new Set(messages.map((message) => message.to || "all"));
  for (const recipient of recipients) {
    pushJson(
      objects,
      `mailbox/by-recipient/${safePathSegment(recipient)}.json`,
      messages.filter((message) => (message.to || "all") === recipient)
    );
  }

  const channelIds = new Set([
    ...channels.map((channel) => channel.id),
    ...channelMessages.map((message) => message.channelId)
  ].filter(Boolean));
  for (const channelId of channelIds) {
    pushJson(
      objects,
      `channels/by-channel/${safePathSegment(channelId)}.json`,
      channelMessages.filter((message) => message.channelId === channelId)
    );
  }

  return objects;
}
