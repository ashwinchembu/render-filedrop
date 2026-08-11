const $ = (selector) => document.querySelector(selector);
const state = { conversations: [], activeId: "", filter: "unread", password: "", drafts: [], pendingSends: [], pendingReactions: [], sentDraftKeys: new Set(), generation: null, replyTarget: null, task: null, taskSource: null, taskPoller: null };

const escapeHtml = (value) => String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const initials = (name) => name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
const displayTime = (value) => new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" }).format(new Date(value));
const zonedDateKey = (value) => new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "America/Los_Angeles" }).format(new Date(value));
const displaySidebarTime = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return String(value || "");
  if (zonedDateKey(date) === zonedDateKey(new Date())) return displayTime(date);
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "America/Los_Angeles" }).format(date);
};
const displayFullTime = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return String(value || "");
  const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" }).format(date);
  return `${day} · ${displayTime(date)}`;
};
const cleanMessageText = (value) => String(value || "")
  .replace(/�\?T/g, "'")
  .replace(/â€™/g, "’")
  .replace(/â€˜/g, "‘")
  .replace(/â€œ|â€/g, '"')
  .replace(/â€”/g, "—")
  .replace(/â€“/g, "–")
  .replace(/â€¢/g, "•")
  .replace(/â€¦/g, "…")
  .replace(/Â(?=\s|$)/g, "")
  .trim();
const extractReaction = (value) => {
  const text = cleanMessageText(value);
  const match = text.match(/(?:\s+|^)(\d+)\s+(Like|Heart|Laugh|Surprised|Sad|Angry) reaction(?: with [^.]+)?\.?\s*$/i);
  if (!match) return { text, reaction: "" };
  const emoji = { like: "👍", heart: "❤️", laugh: "😂", surprised: "😮", sad: "😢", angry: "😠" };
  return { text: text.slice(0, match.index).trim(), reaction: `${emoji[match[2].toLowerCase()] || "•"} ${match[1]}` };
};
const keyFor = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

function parseReport(row) {
  const body = cleanMessageText(row.body);
  if (!/Latest inbound messages from|Exact visible context and latest relevant messages from|RAW(?:\s+KILIAN|\s+TEAMS|\s+MESSAGE|\s+THREAD)|(?:sent|message)\s+(?:in|to)\s+.+?Teams|Teams (?:chat|message)/i.test(body)) return null;
  const entries = [...body.matchAll(/\[([^\]]+)\]\s*["“]([^"”]+)["”]/g)];
  const explicit = body.match(/Latest inbound messages from\s+([^:]+):/i)?.[1]?.trim()
    || body.match(/latest relevant messages from the\s+(.+?)\s+direct chat/i)?.[1]?.trim();
  const names = entries.map((match) => match[1].split(",").at(-1)?.trim()).filter((name) => name && !/^\d|ashwin/i.test(name));
  let person = explicit || names[0] || (/kilian/i.test(body) ? "Kilian Lize" : /aman\s*deep/i.test(body) ? "Aman Deep Sharma" : "");
  if (entries.length && person) {
    return { person, messages: entries.map((match, index) => {
      const parts = match[1].split(",").map((part) => part.trim());
      const sender = parts.length > 1 ? parts.at(-1) : person;
      const outbound = /ashwin/i.test(sender);
      const timestamp = (parts.length > 1 ? parts.slice(0, -1).join(", ") : parts[0]).replace(/\s*PDT$/i, "");
      const reaction = extractReaction(match[2]);
      return { id: `${row.id}-${index}`, sender: outbound ? "You" : cleanMessageText(sender), timestamp, createdAt: row.createdAt, text: reaction.text, reaction: reaction.reaction, direction: outbound ? "outbound" : "inbound", deliveryStatus: outbound ? "Sent in Teams" : "" };
    }) };
  }
  const sent = body.match(/Sent to\s+(.+?)\s+at\s+[^:]+:\s*["“]([\s\S]*?)["”](?:\s|$)/i)
    || body.match(/Teams message sent(?: once)? to\s+([^.;\n]+)[\s\S]*?Exact text:\s*["“]?([^"”\n]+)["”]?/i);
  if (sent) person = sent[1].trim();
  const exact = body.match(/Sent exactly\s+["“]?(.+?)["”]?\s+to\s+(.+?)\s+in Teams/i);
  if (exact) return { person: cleanMessageText(exact[2]), messages: [{ id: row.id, sender: "You", timestamp: displayFullTime(row.createdAt), createdAt: row.createdAt, text: cleanMessageText(exact[1]), direction: "outbound", deliveryStatus: "Sent in Teams" }] };
  if (sent) return { person: cleanMessageText(person), messages: [{ id: row.id, sender: "You", timestamp: displayFullTime(row.createdAt), createdAt: row.createdAt, text: cleanMessageText(sent[2]), direction: "outbound", deliveryStatus: "Sent in Teams" }] };
  const raw = body.match(/^RAW(?:\s+KILIAN|\s+TEAMS|\s+MESSAGE|\s+THREAD)[^\n]*\n([\s\S]+)/im);
  if (!raw || !person) return null;
  const reaction = extractReaction(raw[1]);
  return { person: cleanMessageText(person), messages: [{ id: row.id, sender: cleanMessageText(person), timestamp: displayFullTime(row.createdAt), createdAt: row.createdAt, text: reaction.text, reaction: reaction.reaction, direction: "inbound" }] };
}

function parseStructured(row) {
  let event;
  try { event = JSON.parse(row.body); } catch { return null; }
  if (event?.version !== 1 || !["teams_message", "teams_draft_update"].includes(event?.type) || !event.conversationName) return null;
  if (event.type === "teams_message" && !event.text) return null;
  const direction = event.direction === "outbound" ? "outbound" : "inbound";
  const occurredAt = event.timestamp || row.createdAt;
  const message = extractReaction(event.text);
  return {
    person: cleanMessageText(event.conversationName),
    conversationId: String(event.conversationId || ""),
    suggestedDrafts: Array.isArray(event.suggestedDrafts) ? event.suggestedDrafts.map(cleanMessageText).filter((text) => text.trim()) : (event.suggestedDraft ? [cleanMessageText(event.suggestedDraft)] : []),
    sensitivity: event.sensitivity === "sensitive" ? "sensitive" : "ordinary",
    recentWorkContext: cleanMessageText(event.recentWorkContext),
    isDraftUpdate: event.type === "teams_draft_update",
    messages: event.type === "teams_draft_update" ? [] : [{
      id: String(event.sourceMessageId || row.id),
      sender: direction === "outbound" ? "You" : cleanMessageText(event.sender || event.conversationName),
      timestamp: displayFullTime(occurredAt),
      createdAt: occurredAt,
      text: message.text || (message.reaction ? "[reaction]" : ""),
      reaction: message.reaction,
      direction,
      deliveryStatus: direction === "outbound" ? "Sent in Teams" : "",
      imageFileIds: Array.isArray(event.imageFileIds) ? event.imageFileIds.map(String).filter(Boolean) : (row.relatedFileId ? [row.relatedFileId] : [])
    }]
  };
}

function makeConversations(rows, structured = false) {
  const map = new Map();
  const parsedRows = rows.map((row) => ({ row, parsed: structured ? parseStructured(row) : parseReport(row) })).filter(({ parsed }) => parsed);
  parsedRows.sort((a, b) => String(a.parsed.messages.at(-1)?.createdAt || a.row.createdAt).localeCompare(String(b.parsed.messages.at(-1)?.createdAt || b.row.createdAt))).forEach(({ row, parsed }) => {
    const id = parsed.conversationId ? keyFor(parsed.conversationId) : keyFor(parsed.person);
    const item = map.get(id) || { id, person: parsed.person, messages: [], unread: 0, sourceMessageIds: [], lastSeen: "", lastOccurredAt: "", priority: /kilian/i.test(parsed.person) ? "high" : "normal", suggestedDrafts: [], sensitivity: "ordinary", recentWorkContext: "", seenMessageIds: new Set() };
    parsed.messages.forEach((message) => {
      if (item.seenMessageIds.has(message.id)) return;
      item.seenMessageIds.add(message.id);
      item.messages.push(message);
      if (message.direction === "inbound") item.unread += 1;
    });
    item.sourceMessageIds.push(row.id);
    if (parsed.suggestedDrafts?.length) item.suggestedDrafts = parsed.suggestedDrafts;
    if (parsed.recentWorkContext) item.recentWorkContext = parsed.recentWorkContext;
    if (parsed.sensitivity === "sensitive") item.sensitivity = "sensitive";
    map.set(id, item);
  });
  return [...map.values()].map((item) => {
    item.messages.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
    item.lastOccurredAt = item.messages.at(-1)?.createdAt || "";
    item.lastSeen = displaySidebarTime(item.lastOccurredAt);
    delete item.seenMessageIds;
    return item;
  }).sort((a, b) => new Date(b.lastOccurredAt || 0) - new Date(a.lastOccurredAt || 0));
}

function draftsFor(conversation) {
  if (!conversation) return [];
  const latest = conversation.messages.filter((m) => m.direction === "inbound").at(-1)?.text.toLowerCase() || "";
  const person = conversation.person.toLowerCase();
  const suggested = normalizeDraftBubbles(conversation.suggestedDrafts || []);
  const formalCachedDraft = /\bunderstood\b|purposeful|fully formatted|communicated the timing|firm ETA/i.test(suggested.join(" "));
  if (person.includes("kilian") && /we(?:'re| are) good for now|no follow[- ]?up|nothing else needed/i.test(latest)) return ["sounds good, thank you"];
  if (suggested.length && !(person.includes("kilian") && formalCachedDraft)) return suggested;
  if (person.includes("kilian")) return ["i understand what you mean", "i’ll clean it up and make sure it’s client ready"];
  if (person.includes("yashodeep")) return ["i’ve reviewed the request and i’m working from the latest source", "i’ll send the validated result with the exact file or query location once the final check is complete"];
  if (person.includes("abhinav") || person.includes("abhinao")) return ["i’ve got it and i’m reviewing the latest version now", "i’ll send the confirmed result and any remaining action items once the check is complete"];
  if (person.includes("aman") && /assignee|owner/.test(latest)) return ["i meant the Owner column", "if it already has someone like james or emmy, leave it", "choose an open one and send me a screenshot if none are available"];
  if (/connect|call/.test(latest)) return ["we don’t need to connect unless you prefer to", "send me what you need here and i can take care of it"];
  return ["got it", "i’ll review it and send you an update"];
}

function active() { return state.conversations.find((item) => item.id === state.activeId) || state.conversations[0]; }
function normalizeDraftBubbles(drafts, keepEmpty = false) {
  const normalized = drafts.flatMap((draft) => String(draft).split(/(?:\r?\n)+|(?<=[.!?])\s+/)).map((text) => text.trim().replace(/\.$/, ""));
  return keepEmpty ? normalized : normalized.filter(Boolean);
}
function draftKey(item, text) {
  const latestInboundId = item?.messages.filter((message) => message.direction === "inbound").at(-1)?.id || "";
  return `${item?.id || ""}:${latestInboundId}:${String(text).trim()}`;
}
function updateCount() {
  const label = `${state.drafts.length} message${state.drafts.length === 1 ? "" : "s"}`;
  $("#count").textContent = label;
  $("#modal-count").textContent = label;
  $("#approve").disabled = !active() || !state.drafts.length || state.drafts.some((text) => !text.trim());
}
function renderDrafts(drafts) {
  state.drafts = normalizeDraftBubbles(drafts, true).filter((text) => !text || !state.sentDraftKeys.has(draftKey(active(), text)));
  $("#reply-list").innerHTML = state.drafts.map((text, index) => `<div class="reply-item"><span class="reply-number">${index + 1}</span><textarea rows="3" data-draft-index="${index}" aria-label="Message ${index + 1}">${escapeHtml(text)}</textarea><div class="reply-actions"><button data-modal-send-draft="${index}">Send</button><button data-modal-cancel-draft="${index}">Cancel</button></div></div>`).join("");
  document.querySelectorAll("[data-draft-index]").forEach((input) => input.addEventListener("input", () => { state.drafts[Number(input.dataset.draftIndex)] = input.value; updateCount(); }));
  document.querySelectorAll("[data-draft-index]").forEach((input) => input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    const index = Number(input.dataset.draftIndex);
    const before = input.value.slice(0, input.selectionStart).trim();
    const after = input.value.slice(input.selectionEnd).trim();
    state.drafts.splice(index, 1, before, after);
    renderDrafts(state.drafts.filter(Boolean));
    document.querySelector(`[data-draft-index="${Math.min(index + 1, state.drafts.length - 1)}"]`)?.focus();
  }));
  document.querySelectorAll("[data-draft-index]").forEach((input) => input.addEventListener("blur", () => {
    const normalized = normalizeDraftBubbles(state.drafts);
    if (normalized.length !== state.drafts.length) renderDrafts(normalized);
  }));
  document.querySelectorAll("[data-modal-cancel-draft]").forEach((button) => button.addEventListener("click", () => { state.drafts.splice(Number(button.dataset.modalCancelDraft), 1); renderDrafts(state.drafts); }));
  document.querySelectorAll("[data-modal-send-draft]").forEach((button) => button.addEventListener("click", () => approveDrafts([state.drafts[Number(button.dataset.modalSendDraft)]])));
  $("#draft-preview").innerHTML = state.drafts.map((text, index) => `<div class="draft-preview-item"><div class="draft-preview-bubble">${escapeHtml(text)}</div><div class="draft-preview-actions"><button data-edit-draft="${index}">Edit</button><button data-send-draft="${index}">Send</button><button data-cancel-draft="${index}">Cancel</button></div></div>`).join("");
  document.querySelectorAll("[data-edit-draft]").forEach((button) => button.addEventListener("click", openDraftModal));
  document.querySelectorAll("[data-cancel-draft]").forEach((button) => button.addEventListener("click", () => { state.drafts.splice(Number(button.dataset.cancelDraft), 1); renderDrafts(state.drafts); }));
  document.querySelectorAll("[data-send-draft]").forEach((button) => button.addEventListener("click", () => approveDrafts([state.drafts[Number(button.dataset.sendDraft)]])));
  updateCount();
}
function setNotice(text, error = false) { const node = $("#notice"); node.hidden = !text; node.textContent = text; node.style.background = error ? "#fff0e9" : "#dff7ee"; node.style.color = error ? "#99462f" : "#126d58"; }
function openAuthModal(message = "") {
  $("#auth-error").textContent = message;
  $("#auth-error").hidden = !message;
  if (!$("#auth-modal").open) $("#auth-modal").showModal();
  $("#password").focus();
}

function attachPendingSends() {
  const stillPending = [];
  for (const pending of state.pendingSends) {
    const item = state.conversations.find((conversation) => conversation.id === pending.conversationId || conversation.person === pending.recipient);
    if (!item) { stillPending.push(pending); continue; }
    const confirmed = item.messages.some((message) => {
      if (message.direction !== "outbound" || message.pending || message.text.trim() !== pending.text.trim()) return false;
      const sentAt = new Date(message.createdAt || 0).getTime();
      return Number.isFinite(sentAt) && sentAt >= new Date(pending.createdAt).getTime() - 5000;
    });
    if (confirmed) continue;
    if (!item.messages.some((message) => message.id === pending.id)) item.messages.push(pending);
    stillPending.push(pending);
  }
  state.pendingSends = stillPending;
}

function setGenerationBusy(busy, text = "Generating updated messages…") {
  const status = $("#generation-status");
  status.hidden = !busy;
  status.querySelector("strong").textContent = text;
  $("#regenerate").disabled = busy;
  $("#generate-quick").disabled = busy;
}

function setReplyTarget(item, message) {
  state.replyTarget = message ? { conversationId: item.id, sourceMessageId: message.id, text: message.text, sender: message.sender } : null;
  $("#reply-context").hidden = !state.replyTarget;
  $("#reply-context-text").textContent = state.replyTarget ? `${state.replyTarget.sender}: ${state.replyTarget.text}` : "";
  if (state.replyTarget) $("#manual-reply").focus();
}

async function reactToMessage(item, message, reaction) {
  try {
    const response = await fetch("/approvals/api/react", { method: "POST", headers: { "content-type": "application/json", "x-upload-password": state.password }, body: JSON.stringify({ recipient: item.person, sourceMessageId: message.id, messageText: message.text, reaction }) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not queue reaction");
    state.pendingReactions.push({ id: payload.messageId, conversationId: item.id, sourceMessageId: message.id, reaction });
    selectConversation(item.id);
    setNotice(`${reaction} queued for ${item.person}'s message`);
  } catch (error) { setNotice(error.message, true); }
}

function groupMessages(messages) {
  return messages.reduce((groups, message, index) => {
    const previousGroup = groups.at(-1);
    const previous = previousGroup?.messages.at(-1)?.message;
    const currentTime = new Date(message.createdAt || 0).valueOf();
    const previousTime = new Date(previous?.createdAt || 0).valueOf();
    const closeInTime = Number.isFinite(currentTime) && Number.isFinite(previousTime) && currentTime - previousTime <= 5 * 60_000;
    if (previousGroup && previousGroup.sender === message.sender && previousGroup.direction === message.direction && closeInTime) {
      previousGroup.messages.push({ message, index });
      return groups;
    }
    groups.push({ id: message.id, sender: message.sender, direction: message.direction, messages: [{ message, index }] });
    return groups;
  }, []);
}

function switchSideMode(mode) {
  const taskMode = mode === "task";
  $("#reply-panel").hidden = taskMode;
  $("#task-panel").hidden = !taskMode;
  $("#reply-tab").classList.toggle("active", !taskMode);
  $("#task-tab").classList.toggle("active", taskMode);
  $("#reply-tab").setAttribute("aria-selected", String(!taskMode));
  $("#task-tab").setAttribute("aria-selected", String(taskMode));
}

function renderTask() {
  const task = state.task;
  $("#task-tab-dot").hidden = !task;
  $("#task-tab-dot").className = `task-dot ${task?.status || ""}`;
  if (!task) {
    $("#task-status").hidden = true;
    $("#task-heading").textContent = "No task running";
    $("#task-content").innerHTML = '<div class="task-empty"><span>▷</span><strong>Choose a message to handle</strong><p>Select “Do task” under an inbound message. Its exact text and recent chat context will be passed to a fresh Codex task.</p></div>';
    return;
  }
  $("#task-status").hidden = false;
  $("#task-status").textContent = task.status;
  $("#task-status").className = `task-status ${task.status}`;
  $("#task-heading").textContent = "Task progress";
  const source = state.taskSource || {};
  const progress = task.progress?.length
    ? `<ol class="progress-list">${task.progress.map((item, index) => `<li><span class="progress-mark">${index === task.progress.length - 1 && !["completed", "blocked", "failed"].includes(task.status) ? "◌" : "✓"}</span><div><time>${escapeHtml(displayTime(item.timestamp))}</time><p>${escapeHtml(cleanMessageText(item.text || "Progress received"))}</p></div></li>`).join("")}</ol>`
    : '<ol class="progress-list"><li><span class="progress-mark">◌</span><div><time>now</time><p>Waiting for the worker to acknowledge the task</p></div></li></ol>';
  const response = task.response ? `<div class="task-response ${task.status}"><p class="eyebrow">${task.status === "completed" ? "FINAL RESPONSE" : "TASK UPDATE"}</p><div>${escapeHtml(cleanMessageText(task.response))}</div></div>` : "";
  const thread = task.threadUrl && /^https:\/\//i.test(task.threadUrl) ? `<a class="thread-link" href="${escapeHtml(task.threadUrl)}" target="_blank" rel="noreferrer">Open Codex task ↗</a>` : "";
  $("#task-content").innerHTML = `<div class="task-source"><p class="eyebrow">SOURCE MESSAGE · ${escapeHtml(source.timestamp || "")}</p><strong>${escapeHtml(source.sender || active()?.person || "Teammate")}</strong><p>${escapeHtml(source.text || "")}</p></div>${progress}${response}${thread}`;
}

async function pollTask() {
  if (!state.task?.id || ["completed", "blocked", "failed"].includes(state.task.status)) return;
  try {
    const response = await fetch(`/approvals/api/task?id=${encodeURIComponent(state.task.id)}`, { headers: { "x-upload-password": state.password }, cache: "no-store" });
    const payload = await response.json();
    if (!response.ok || !payload.ok || !payload.task) throw new Error(payload.error || "Could not read task");
    state.task = payload.task;
    renderTask();
    if (["completed", "blocked", "failed"].includes(state.task.status) && state.taskPoller) {
      clearInterval(state.taskPoller);
      state.taskPoller = null;
    }
  } catch { /* Keep current progress and retry. */ }
}

async function startTask(item, message) {
  switchSideMode("task");
  state.taskSource = message;
  state.task = { id: "", status: "queued", progress: [{ timestamp: new Date().toISOString(), text: "Starting task…" }] };
  renderTask();
  document.querySelectorAll("[data-task-message]").forEach((button) => { button.disabled = true; button.textContent = "Starting…"; });
  try {
    const response = await fetch("/approvals/api/task", {
      method: "POST",
      headers: { "content-type": "application/json", "x-upload-password": state.password },
      body: JSON.stringify({ recipient: item.person, message, context: item.messages, sourceMessageIds: item.sourceMessageIds })
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok || !payload.task) throw new Error(payload.error || "Could not start task");
    state.task = payload.task;
    renderTask();
    if (state.taskPoller) clearInterval(state.taskPoller);
    state.taskPoller = setInterval(pollTask, 4000);
    pollTask();
  } catch (error) {
    state.task = { id: "", status: "failed", progress: [], response: error.message || "Could not start task" };
    renderTask();
  } finally {
    document.querySelectorAll("[data-task-message]").forEach((button) => { button.disabled = false; button.textContent = "Do task"; });
  }
}

function renderConversationList() {
  const query = $("#search").value.trim().toLowerCase();
  const visible = state.conversations.filter((item) => state.filter === "all" || item.unread > 0).filter((item) => !query || `${item.person} ${item.messages.map((m) => m.text).join(" ")}`.toLowerCase().includes(query));
  $("#waiting").textContent = `${state.conversations.reduce((sum, item) => sum + item.unread, 0)} waiting`;
  $("#conversations").innerHTML = visible.length ? visible.map((item) => {
    const last = item.messages.at(-1);
    return `<button class="conversation ${item.id === active()?.id ? "selected" : ""}" data-id="${item.id}"><span class="avatar ${item.priority === "high" ? "urgent" : ""}">${initials(item.person)}</span><span class="conversation-copy"><span class="conversation-top"><strong>${escapeHtml(item.person)} ${item.sensitivity === "sensitive" ? '<em class="sensitive-chip">Sensitive</em>' : ""}</strong><time>${item.lastSeen}</time></span><p>${escapeHtml(last?.text)}</p></span>${item.unread ? `<span class="unread">${item.unread}</span>` : ""}</button>`;
  }).join("") : '<p class="empty">No conversations match this view.</p>';
  document.querySelectorAll(".conversation").forEach((button) => button.addEventListener("click", () => selectConversation(button.dataset.id)));
}

function selectConversation(id) {
  state.activeId = id;
  const item = active();
  if (state.replyTarget?.conversationId !== item.id) setReplyTarget(item, null);
  renderConversationList();
  $("#chat-avatar").textContent = initials(item.person);
  $("#chat-name").textContent = item.person;
  $("#sensitive-banner").hidden = item.sensitivity !== "sensitive";
  $("#work-context").textContent = item.recentWorkContext || "No refreshed work context was provided yet. Regenerate to request a fresh check.";
  $("#messages").innerHTML = groupMessages(item.messages).map((group) => {
    const first = group.messages[0].message;
    const blocks = group.messages.map(({ message, index }) => {
      const deliveryStatus = message.deliveryStatus === "Sent in Teams" ? `Sent to ${item.person} in Teams` : message.deliveryStatus;
      const reactions = state.pendingReactions.filter((pending) => pending.conversationId === item.id && pending.sourceMessageId === message.id);
      return `<div class="message-block">${message.replyToText ? `<div class="reply-preview">Replying to: ${escapeHtml(message.replyToText)}</div>` : ""}<div class="bubble">${escapeHtml(message.text)}</div>${message.reaction ? `<span class="reaction-pill">${escapeHtml(message.reaction)}</span>` : ""}${deliveryStatus ? `<small class="delivery-status">${escapeHtml(deliveryStatus)}</small>` : ""}${reactions.length ? `<div class="reaction-row">${reactions.map((pending) => `<span class="reaction-chip pending" title="Queued for Windows Teams sender">${escapeHtml(pending.reaction)}</span>`).join("")}</div>` : ""}${message.direction === "inbound" ? `<button class="task-trigger" data-task-message="${index}">Do task</button>` : ""}<div class="message-actions"><button data-reply-message="${index}">Reply</button><button data-react-message="${index}" data-reaction="👍" aria-label="Like">👍</button><button data-react-message="${index}" data-reaction="❤️" aria-label="Heart">❤️</button><button data-react-message="${index}" data-reaction="😂" aria-label="Laugh">😂</button></div>${(message.imageFileIds || []).map((fileId) => `<div class="image-card"><img data-image-id="${escapeHtml(fileId)}" alt="Teams screenshot" /><small>Screenshot · ${escapeHtml(fileId)}</small></div>`).join("")}</div>`;
    }).join("");
    return `<article class="message ${group.direction} ${group.messages.some(({ message }) => message.pending) ? "pending" : ""}">${group.direction === "inbound" ? `<span class="avatar">${initials(group.sender)}</span>` : ""}<div class="message-body"><div class="message-meta"><strong>${escapeHtml(group.sender)}</strong><time datetime="${escapeHtml(first.createdAt)}">${escapeHtml(displayFullTime(first.createdAt) || first.timestamp)}</time></div><div class="message-cluster">${blocks}</div></div></article>`;
  }).join("");
  document.querySelectorAll("[data-reply-message]").forEach((button) => button.addEventListener("click", () => setReplyTarget(item, item.messages[Number(button.dataset.replyMessage)])));
  document.querySelectorAll("[data-react-message]").forEach((button) => button.addEventListener("click", () => reactToMessage(item, item.messages[Number(button.dataset.reactMessage)], button.dataset.reaction)));
  document.querySelectorAll("[data-task-message]").forEach((button) => button.addEventListener("click", () => startTask(item, item.messages[Number(button.dataset.taskMessage)])));
  hydrateImages();
  $("#messages").scrollTop = $("#messages").scrollHeight;
  renderDrafts(draftsFor(item));
  setNotice("");
  updateCount();
}

async function hydrateImages() {
  for (const image of document.querySelectorAll("img[data-image-id]")) {
    try {
      const response = await fetch(`/approvals/api/files/${encodeURIComponent(image.dataset.imageId)}`, { headers: { "x-upload-password": state.password } });
      if (!response.ok) throw new Error("image unavailable");
      image.src = URL.createObjectURL(await response.blob());
    } catch { image.closest(".image-card")?.classList.add("unavailable"); }
  }
}

async function refresh() {
  $("#refresh").disabled = true;
  try {
    const headers = state.password ? { "x-upload-password": state.password } : {};
    const response = await fetch("/approvals/api/inbox", { headers, cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not load messages");
    const pushed = makeConversations(payload.events || [], true);
    const legacy = makeConversations(payload.messages || []);
    const pushedPeople = new Set(pushed.map((item) => item.person.toLowerCase()));
    state.conversations = [...pushed, ...legacy.filter((item) => !pushedPeople.has(item.person.toLowerCase()))];
    attachPendingSends();
    if (state.generation) {
      const generatedConversation = state.conversations.find((item) => item.id === state.generation.conversationId);
      const signature = JSON.stringify(generatedConversation?.suggestedDrafts || []);
      if (signature && signature !== state.generation.beforeSignature) {
        state.generation = null;
        setGenerationBusy(false);
        setNotice("Generated messages are ready to review");
      }
    }
    if (!state.conversations.some((item) => item.id === state.activeId)) state.activeId = state.conversations[0]?.id || "";
    $("#status").classList.add("connected");
    if ($("#auth-modal").open) $("#auth-modal").close();
    $("#status strong").textContent = "FileDrop connected";
    $("#status small").textContent = `last checked ${displayTime(payload.syncedAt)}`;
    renderConversationList();
    if (active()) selectConversation(active().id);
  } catch (error) {
    $("#status").classList.remove("connected");
    $("#status strong").textContent = "Connection failed";
    $("#status small").textContent = error.message;
    if (/invalid upload password/i.test(error.message)) openAuthModal();
  } finally { $("#refresh").disabled = false; }
}

$("#connect").addEventListener("click", async () => {
  const password = $("#password").value;
  try {
    const response = await fetch("/approvals/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not connect");
    $("#password").value = "";
    $("#auth-modal").close();
    await refresh();
  } catch (error) {
    $("#status").classList.remove("connected");
    $("#status strong").textContent = "Connection failed";
    $("#status small").textContent = error.message;
    openAuthModal(error.message);
  }
});
$("#password").addEventListener("keydown", (event) => { if (event.key === "Enter") $("#connect").click(); });
$("#refresh").addEventListener("click", refresh);
$("#search").addEventListener("input", renderConversationList);
document.querySelectorAll("[data-filter]").forEach((button) => button.addEventListener("click", () => { state.filter = button.dataset.filter; document.querySelectorAll("[data-filter]").forEach((item) => item.classList.toggle("active", item === button)); renderConversationList(); }));
function openDraftModal() {
  $("#draft-direction").value = $("#draft-direction-quick").value;
  renderDrafts(state.drafts);
  if (!$("#draft-modal").open) $("#draft-modal").showModal();
  $("#draft-direction").focus();
}
async function requestRegeneration(direction) {
  const item = active();
  if (!item) return;
  if (!direction) { setNotice("Describe what you want to say first", true); $("#draft-direction-quick").focus(); return; }
  $("#draft-direction-quick").value = direction;
  openDraftModal();
  state.generation = { conversationId: item.id, beforeSignature: JSON.stringify(item.suggestedDrafts || []) };
  setGenerationBusy(true);
  const latestInbound = item.messages.filter((message) => message.direction === "inbound").at(-1);
  try {
    const response = await fetch("/approvals/api/regenerate", { method: "POST", headers: { "content-type": "application/json", "x-upload-password": state.password }, body: JSON.stringify({ recipient: item.person, conversationId: item.id, sourceMessageId: latestInbound?.id || "", latestInboundText: latestInbound?.text || "", direction }) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not generate messages");
    setNotice(`Generating updated messages for ${item.person}…`);
    window.setTimeout(refresh, 3000);
    window.setTimeout(refresh, 7000);
    window.setTimeout(refresh, 14000);
    window.setTimeout(refresh, 25000);
    const generationRequest = state.generation;
    window.setTimeout(() => {
      if (state.generation !== generationRequest) return;
      state.generation = null;
      setGenerationBusy(false);
      setNotice("The generator is still working. You can keep editing the current messages.");
    }, 30000);
  } catch (error) { state.generation = null; setGenerationBusy(false); setNotice(error.message, true); }
}
$("#generate-quick").addEventListener("click", () => requestRegeneration($("#draft-direction-quick").value.trim()));
$("#draft-direction-quick").addEventListener("keydown", (event) => { if (event.key === "Enter") requestRegeneration($("#draft-direction-quick").value.trim()); });
$("#draft-direction").addEventListener("input", () => { $("#draft-direction-quick").value = $("#draft-direction").value; });
$("#close-draft").addEventListener("click", () => $("#draft-modal").close());
$("#save-draft").addEventListener("click", () => { renderDrafts(state.drafts); $("#draft-modal").close(); });
$("#add-message").addEventListener("click", () => renderDrafts([...state.drafts, ""]));
$("#regenerate").addEventListener("click", () => requestRegeneration($("#draft-direction").value.trim()));
$("#hold").addEventListener("click", () => setNotice("Saved for later — nothing was sent"));
async function approveDrafts(drafts, options = {}) {
  const item = active();
  if (!item || !drafts.length || drafts.some((text) => !text.trim())) return false;
  let queued = false;
  $("#approve").disabled = true;
  try {
    const response = await fetch("/approvals/api/approve", { method: "POST", headers: { "content-type": "application/json", "x-upload-password": state.password }, body: JSON.stringify({ recipient: item.person, drafts: drafts.map((text) => text.trim()), sourceMessageIds: item.sourceMessageIds, replyToSourceMessageId: options.replyToSourceMessageId || "", replyToText: options.replyToText || "" }) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not queue reply");
    const createdAt = new Date().toISOString();
    drafts.forEach((text) => state.sentDraftKeys.add(draftKey(item, text)));
    drafts.forEach((text, index) => state.pendingSends.push({ id: `pending-${payload.messageId}-${index}`, conversationId: item.id, recipient: item.person, sender: "You", text: text.trim(), direction: "outbound", timestamp: displayTime(createdAt), createdAt, pending: true, deliveryStatus: "Queued for Windows Teams sender", replyToText: options.replyToText || "" }));
    attachPendingSends();
    renderDrafts(state.drafts);
    selectConversation(item.id);
    setNotice(`${drafts.length} message${drafts.length === 1 ? "" : "s"} queued for the Windows Teams sender`);
    window.setTimeout(refresh, 2500);
    window.setTimeout(refresh, 8000);
    window.setTimeout(refresh, 20000);
    queued = true;
  } catch (error) { setNotice(error.message, true); }
  updateCount();
  return queued;
}
$("#approve").addEventListener("click", async () => {
  await approveDrafts(state.drafts);
});
$("#clear-reply").addEventListener("click", () => setReplyTarget(active(), null));
$("#send-manual").addEventListener("click", async () => {
  const text = $("#manual-reply").value.trim();
  if (!text) return;
  const replyTarget = state.replyTarget;
  const queued = await approveDrafts([text], { replyToSourceMessageId: replyTarget?.sourceMessageId || "", replyToText: replyTarget?.text || "" });
  if (!queued) return;
  $("#manual-reply").value = "";
  setReplyTarget(active(), null);
});
$("#manual-reply").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey) return;
  event.preventDefault();
  $("#send-manual").click();
});
$("#reply-tab").addEventListener("click", () => switchSideMode("reply"));
$("#task-tab").addEventListener("click", () => switchSideMode("task"));

renderTask();
refresh();
setInterval(refresh, 30000);
