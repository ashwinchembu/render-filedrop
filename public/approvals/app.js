const $ = (selector) => document.querySelector(selector);
const state = { conversations: [], activeId: "", filter: "unread", password: sessionStorage.getItem("filedropApprovalPassword") || "" };

const escapeHtml = (value) => String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const initials = (name) => name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
const displayTime = (value) => new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" }).format(new Date(value));
const keyFor = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

function parseReport(row) {
  const body = String(row.body || "");
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
      return { id: `${row.id}-${index}`, sender: outbound ? "You" : sender, timestamp: (parts.length > 1 ? parts.slice(0, -1).join(", ") : parts[0]).replace(/\s*PDT$/i, ""), text: match[2], direction: outbound ? "outbound" : "inbound" };
    }) };
  }
  const sent = body.match(/Sent to\s+(.+?)\s+at\s+[^:]+:\s*["“]([\s\S]*?)["”](?:\s|$)/i)
    || body.match(/Teams message sent(?: once)? to\s+([^.;\n]+)[\s\S]*?Exact text:\s*["“]?([^"”\n]+)["”]?/i);
  if (sent) person = sent[1].trim();
  const exact = body.match(/Sent exactly\s+["“]?(.+?)["”]?\s+to\s+(.+?)\s+in Teams/i);
  if (exact) return { person: exact[2].trim(), messages: [{ id: row.id, sender: "You", timestamp: displayTime(row.createdAt), text: exact[1].trim(), direction: "outbound" }] };
  if (sent) return { person, messages: [{ id: row.id, sender: "You", timestamp: displayTime(row.createdAt), text: sent[2].trim(), direction: "outbound" }] };
  const raw = body.match(/^RAW(?:\s+KILIAN|\s+TEAMS|\s+MESSAGE|\s+THREAD)[^\n]*\n([\s\S]+)/im);
  return raw && person ? { person, messages: [{ id: row.id, sender: person, timestamp: displayTime(row.createdAt), text: raw[1].trim(), direction: "inbound" }] } : null;
}

function parseStructured(row) {
  let event;
  try { event = JSON.parse(row.body); } catch { return null; }
  if (event?.version !== 1 || event?.type !== "teams_message" || !event.conversationName || !event.text) return null;
  const direction = event.direction === "outbound" ? "outbound" : "inbound";
  return {
    person: String(event.conversationName),
    conversationId: String(event.conversationId || ""),
    suggestedDraft: String(event.suggestedDraft || ""),
    sensitivity: event.sensitivity === "sensitive" ? "sensitive" : "ordinary",
    messages: [{
      id: String(event.sourceMessageId || row.id),
      sender: direction === "outbound" ? "You" : String(event.sender || event.conversationName),
      timestamp: event.timestamp ? displayTime(event.timestamp) : displayTime(row.createdAt),
      text: String(event.text),
      direction,
      imageFileIds: Array.isArray(event.imageFileIds) ? event.imageFileIds.map(String).filter(Boolean) : (row.relatedFileId ? [row.relatedFileId] : [])
    }]
  };
}

function makeConversations(rows, structured = false) {
  const map = new Map();
  [...rows].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).forEach((row) => {
    const parsed = structured ? parseStructured(row) : parseReport(row);
    if (!parsed) return;
    const id = parsed.conversationId ? keyFor(parsed.conversationId) : keyFor(parsed.person);
    const item = map.get(id) || { id, person: parsed.person, messages: [], unread: 0, sourceMessageIds: [], lastSeen: "", priority: /kilian/i.test(parsed.person) ? "high" : "normal", suggestedDraft: "", sensitivity: "ordinary" };
    item.messages.push(...parsed.messages);
    item.unread += parsed.messages.filter((message) => message.direction === "inbound").length;
    item.sourceMessageIds.push(row.id);
    item.lastSeen = displayTime(row.createdAt);
    if (parsed.suggestedDraft) item.suggestedDraft = parsed.suggestedDraft;
    if (parsed.sensitivity === "sensitive") item.sensitivity = "sensitive";
    map.set(id, item);
  });
  return [...map.values()].reverse();
}

function draftFor(conversation) {
  if (!conversation) return "";
  if (conversation.suggestedDraft) return conversation.suggestedDraft;
  const latest = conversation.messages.filter((m) => m.direction === "inbound").at(-1)?.text.toLowerCase() || "";
  const person = conversation.person.toLowerCase();
  if (person.includes("aman") && /assignee|owner/.test(latest)) return "yeah i mean the Owner column. if it already has someone like james or emmy don’t pick it. choose an open one without an owner. if u don’t see one send me a screenshot and we can connect";
  if (person.includes("kilian") && /eta|wait|client/.test(latest)) return "yeah ur right i should’ve communicated the ETA better. the Medical Current sheet is complete with every row marked Keep or Delete and the final workbook is ready. i’m doing the last SharePoint verification now and i’ll send u the confirmed file and exact ETA instead of leaving u waiting";
  if (/connect|call/.test(latest)) return "we don’t have to connect unless u want to. send me what u need here and i can take care of it";
  return "got it i’ll take a look and send u an update";
}

function active() { return state.conversations.find((item) => item.id === state.activeId) || state.conversations[0]; }
function updateCount() { $("#count").textContent = `${$("#reply").value.length} characters`; $("#approve").disabled = !active() || !$("#reply").value.trim(); }
function setNotice(text, error = false) { const node = $("#notice"); node.hidden = !text; node.textContent = text; node.style.background = error ? "#fff0e9" : "#dff7ee"; node.style.color = error ? "#99462f" : "#126d58"; }

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
  renderConversationList();
  $("#chat-avatar").textContent = initials(item.person);
  $("#chat-name").textContent = item.person;
  $("#sensitive-banner").hidden = item.sensitivity !== "sensitive";
  $("#messages").innerHTML = item.messages.map((message) => `<article class="message ${message.direction}">${message.direction === "inbound" ? `<span class="avatar">${initials(message.sender)}</span>` : ""}<div class="message-body"><div class="message-meta"><strong>${escapeHtml(message.sender)}</strong><time>${escapeHtml(message.timestamp)}</time></div><div class="bubble">${escapeHtml(message.text)}</div>${(message.imageFileIds || []).map((fileId) => `<div class="image-card"><img data-image-id="${escapeHtml(fileId)}" alt="Teams screenshot" /><small>Screenshot · ${escapeHtml(fileId)}</small></div>`).join("")}</div></article>`).join("");
  hydrateImages();
  $("#messages").scrollTop = $("#messages").scrollHeight;
  $("#reply").value = draftFor(item);
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
  if (!state.password) return;
  $("#refresh").disabled = true;
  try {
    const response = await fetch("/approvals/api/inbox", { headers: { "x-upload-password": state.password }, cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not load messages");
    const pushed = makeConversations(payload.events || [], true);
    const legacy = makeConversations(payload.messages || []);
    const pushedPeople = new Set(pushed.map((item) => item.person.toLowerCase()));
    state.conversations = [...pushed, ...legacy.filter((item) => !pushedPeople.has(item.person.toLowerCase()))];
    if (!state.conversations.some((item) => item.id === state.activeId)) state.activeId = state.conversations[0]?.id || "";
    $("#status").classList.add("connected");
    $("#status strong").textContent = "FileDrop connected";
    $("#status small").textContent = `last checked ${displayTime(payload.syncedAt)}`;
    renderConversationList();
    if (active()) selectConversation(active().id);
  } catch (error) {
    $("#status").classList.remove("connected");
    $("#status strong").textContent = "Connection failed";
    $("#status small").textContent = error.message;
  } finally { $("#refresh").disabled = false; }
}

$("#password").value = state.password;
$("#connect").addEventListener("click", () => { state.password = $("#password").value; sessionStorage.setItem("filedropApprovalPassword", state.password); refresh(); });
$("#password").addEventListener("keydown", (event) => { if (event.key === "Enter") $("#connect").click(); });
$("#refresh").addEventListener("click", refresh);
$("#search").addEventListener("input", renderConversationList);
document.querySelectorAll("[data-filter]").forEach((button) => button.addEventListener("click", () => { state.filter = button.dataset.filter; document.querySelectorAll("[data-filter]").forEach((item) => item.classList.toggle("active", item === button)); renderConversationList(); }));
$("#reply").addEventListener("input", updateCount);
$("#regenerate").addEventListener("click", () => { $("#reply").value = draftFor(active()); updateCount(); });
$("#hold").addEventListener("click", () => setNotice("Held — nothing was sent"));
$("#approve").addEventListener("click", async () => {
  const item = active();
  if (!item || !$("#reply").value.trim()) return;
  $("#approve").disabled = true;
  try {
    const response = await fetch("/approvals/api/approve", { method: "POST", headers: { "content-type": "application/json", "x-upload-password": state.password }, body: JSON.stringify({ recipient: item.person, draft: $("#reply").value.trim(), sourceMessageIds: item.sourceMessageIds }) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not queue reply");
    setNotice("Approved — queued for the Windows computer to send in Teams");
  } catch (error) { setNotice(error.message, true); }
  updateCount();
});

if (state.password) refresh();
setInterval(() => state.password && refresh(), 30000);
