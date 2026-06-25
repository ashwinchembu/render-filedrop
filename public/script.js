const form = document.querySelector("#uploadForm");
const statusBox = document.querySelector("#status");

function setStatus(html, kind = "") {
  statusBox.className = `status ${kind}`;
  statusBox.innerHTML = html;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = document.querySelector("#file").files[0];
  const password = document.querySelector("#password").value;
  if (!file) return;

  const body = new FormData();
  body.append("file", file);

  setStatus("Uploading...");
  try {
    const response = await fetch("/web/upload", {
      method: "POST",
      headers: { "x-upload-password": password },
      body
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Upload failed");

    setStatus(
      `Ready: <a href="${result.downloadUrl}">${result.name}</a><button class="copy" type="button" data-url="${result.downloadUrl}">Copy link</button>`,
      "success"
    );
  } catch (error) {
    setStatus(error.message, "error");
  }
});

statusBox.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-url]");
  if (!button) return;
  await navigator.clipboard.writeText(button.dataset.url);
  button.textContent = "Copied";
});
