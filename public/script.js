const form = document.querySelector("#uploadForm");
const statusBox = document.querySelector("#status");
const passwordInput = document.querySelector("#password");
const filesBox = document.querySelector("#files");
const summary = document.querySelector("#summary");
const refreshButton = document.querySelector("#refresh");
const searchInput = document.querySelector("#search");
const groupByInput = document.querySelector("#groupBy");

let files = [];

function setStatus(html, kind = "") {
  statusBox.className = `status ${kind}`;
  statusBox.innerHTML = html;
}

function password() {
  return passwordInput.value;
}

function formatSize(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function groupKey(file) {
  const date = new Date(file.uploadedAt);
  if (groupByInput.value === "month") {
    return new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(date);
  }
  if (groupByInput.value === "category") {
    return file.category || "Uncategorized";
  }
  return new Intl.DateTimeFormat(undefined, { dateStyle: "full" }).format(date);
}

function fileMatches(file) {
  const query = searchInput.value.trim().toLowerCase();
  if (!query) return true;
  return [file.name, file.category, file.note, ...(file.tags || [])].join(" ").toLowerCase().includes(query);
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderFiles() {
  const visible = files.filter(fileMatches);
  summary.textContent = `${visible.length} of ${files.length} files`;
  if (!visible.length) {
    filesBox.className = "files-empty";
    filesBox.textContent = files.length ? "No files match that search." : "No files yet.";
    return;
  }

  filesBox.className = "date-groups";
  const groups = new Map();
  for (const file of visible) {
    const key = groupKey(file);
    groups.set(key, [...(groups.get(key) || []), file]);
  }

  filesBox.innerHTML = Array.from(groups.entries())
    .map(([title, groupFiles]) => {
      const rows = groupFiles
        .map(
          (file) => `
            <article class="file-row" data-id="${file.id}">
              <div class="file-main">
                <a href="${file.downloadUrl}" class="file-name">${escapeHtml(file.name)}</a>
                <div class="meta">${formatDate(file.uploadedAt)} · ${formatSize(file.size)}</div>
                <div class="chips">
                  ${(file.category ? [file.category] : []).concat(file.tags || []).map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}
                </div>
                ${file.note ? `<p class="note">${escapeHtml(file.note)}</p>` : ""}
              </div>
              <form class="organize-form">
                <input name="category" value="${escapeHtml(file.category)}" placeholder="Category" />
                <input name="tags" value="${escapeHtml((file.tags || []).join(", "))}" placeholder="Tags" />
                <input name="note" value="${escapeHtml(file.note)}" placeholder="Note" />
                <button type="submit">Save</button>
              </form>
            </article>`
        )
        .join("");
      return `<section class="date-group"><h3>${escapeHtml(title)}</h3>${rows}</section>`;
    })
    .join("");
}

async function loadFiles() {
  if (!password()) {
    files = [];
    renderFiles();
    summary.textContent = "Enter the password to load files.";
    return;
  }
  const response = await fetch("/web/files", {
    headers: { "x-upload-password": password() }
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Could not load files");
  files = result.files;
  renderFiles();
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = document.querySelector("#file").files[0];
  if (!file) return;

  const body = new FormData();
  body.append("file", file);
  body.append("category", document.querySelector("#category").value);
  body.append("tags", document.querySelector("#tags").value);
  body.append("note", document.querySelector("#note").value);

  setStatus("Uploading...");
  try {
    const response = await fetch("/web/upload", {
      method: "POST",
      headers: { "x-upload-password": password() },
      body
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Upload failed");

    setStatus(
      `Ready: <a href="${result.downloadUrl}">${escapeHtml(result.name)}</a><button class="copy" type="button" data-url="${result.downloadUrl}">Copy link</button>`,
      "success"
    );
    form.reset();
    await loadFiles();
  } catch (error) {
    setStatus(error.message, "error");
  }
});

filesBox.addEventListener("submit", async (event) => {
  const editForm = event.target.closest(".organize-form");
  if (!editForm) return;
  event.preventDefault();

  const row = editForm.closest(".file-row");
  const body = Object.fromEntries(new FormData(editForm).entries());
  const response = await fetch(`/web/files/${row.dataset.id}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "x-upload-password": password()
    },
    body: JSON.stringify(body)
  });
  const result = await response.json();
  if (!response.ok) {
    setStatus(result.error || "Could not save file details", "error");
    return;
  }
  files = files.map((file) => (file.id === result.id ? result : file));
  setStatus("Saved.", "success");
  renderFiles();
});

statusBox.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-url]");
  if (!button) return;
  await navigator.clipboard.writeText(button.dataset.url);
  button.textContent = "Copied";
});

refreshButton.addEventListener("click", () => loadFiles().catch((error) => setStatus(error.message, "error")));
passwordInput.addEventListener("change", () => loadFiles().catch((error) => setStatus(error.message, "error")));
searchInput.addEventListener("input", renderFiles);
groupByInput.addEventListener("change", renderFiles);
