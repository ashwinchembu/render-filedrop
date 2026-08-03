# Private Filedrop

## Durable job queue

Use the queue for cross-computer work. Mailbox messages remain useful for human notes, but reminders and executable work should call `enqueue_job` with a stable `dedupeKey`.

Lifecycle:

`queued -> claimed -> in_progress -> blocked/completed`

- `enqueue_job`: creates a durable job or returns the existing job for the same dedupe key.
- `claim_job`: atomically assigns a queued job to one device and session and starts a lease.
- `heartbeat_job`: renews the lease while work is active.
- `update_job`: records progress, blockage, completion, retries, and structured outputs.
- `retry_stale_jobs`: returns expired leases to `queued`; jobs that exhaust `maxAttempts` become `blocked`.
- `list_jobs` / `get_job`: inspect queue state, ownership, attempts, transitions, and outputs.

Every completed job can return structured `links`, `files`, `screenshots`, a short `status`, and non-secret `data`. Secret-shaped fields such as passwords, tokens, cookies, credentials, API keys, OTPs, and 2FA values are rejected from payloads and outputs. Authentication must remain local to the assigned device.

REST clients can use `POST /api/jobs`, `POST /api/jobs/claim`, `POST /api/jobs/:id/heartbeat`, `PATCH /api/jobs/:id`, `POST /api/jobs/retry-stale`, and `GET /api/jobs`.

A tiny Render-hosted file bridge for moving files between computers.

## Features

- Password-protected browser upload page.
- File library grouped by day, month, or category.
- Category, tag, and note fields for organizing files.
- GitHub-lite project, path, version history, and commit-message fields.
- Shared mailbox for Codex-to-Codex handoffs and status messages.
- Unguessable public download links for individual files.
- API-key-protected upload, list, and download endpoints.
- MCP server endpoint for connecting as a ChatGPT custom app.
- S3 or S3-compatible storage support through `render.yaml`.

## Deploy on Render

1. Push this folder to a GitHub repository.
2. In Render, choose **New +** -> **Blueprint**.
3. Select the repo and apply `render.yaml`.
4. After deploy, open the service environment page and reveal these generated values:
   - `UPLOAD_PASSWORD`: use this in the web page.
   - `API_KEY`: use this for API access.

The blueprint uses Render's paid `starter` web service plan with a 1 GB persistent disk mounted at `/var/data/filedrop`. `STORAGE_DIR` points at that mount, so uploaded files, metadata, mailbox messages, channels, and webhook registrations survive deploys and service restarts.

Do not set production `STORAGE_DIR` to `/tmp`; Render's `/tmp` storage is ephemeral and can wipe the mailbox, webhook registry, channels, and file metadata whenever the service restarts.

For durable S3-compatible storage, set these environment variables in Render:

- `STORAGE_DRIVER=s3`
- `S3_BUCKET`
- `S3_REGION`
- `S3_PREFIX=filedrop`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`

For Cloudflare R2 or another S3-compatible provider, also set `S3_ENDPOINT` and usually `S3_FORCE_PATH_STYLE=true`.

### Migrating the existing Render disk to S3

The app stores file records, mailbox messages, channels, and webhook registrations in one `metadata.json`, and stores uploaded file bytes under `files/`. To keep existing handoffs and file history, migrate the local disk before switching production traffic fully to S3.

1. Create the bucket and an access key that can read/write the bucket prefix.
2. In Render, set `S3_BUCKET`, `S3_REGION`, `S3_PREFIX`, `AWS_ACCESS_KEY_ID`, and `AWS_SECRET_ACCESS_KEY`. Keep the existing disk mounted until the migration is verified.
3. Temporarily keep `STORAGE_DRIVER=local`, open a Render shell, and run:

   ```sh
   npm run migrate:local-to-s3 -- --dry-run
   npm run migrate:local-to-s3
   ```

4. Set `STORAGE_DRIVER=s3` and redeploy.
5. Verify `/healthz`, `GET /api/files`, and `GET /api/messages?to=desktop-client&unreadOnly=true`.

Keep the disk attached until the S3-backed service has been stable for a few polling cycles. It is useful as a rollback source.

### S3 layout

The app keeps these canonical objects for compatibility:

- `filedrop/metadata.json`: full application state.
- `filedrop/files/{storageName}`: uploaded file bytes.

Migration and backup jobs also write organized mirrors so the bucket is easier to browse:

- `filedrop/manifests/storage-layout.json`: layout manifest.
- `filedrop/state/metadata.json`: full state snapshot duplicate.
- `filedrop/indexes/files.json`: file records only.
- `filedrop/indexes/projects.json`: project summary.
- `filedrop/mailbox/messages.json`: all control mailbox messages.
- `filedrop/mailbox/unread.json`: unread control mailbox messages.
- `filedrop/mailbox/by-recipient/{recipient}.json`: mailbox split by recipient.
- `filedrop/channels/channels.json`: channel definitions.
- `filedrop/channels/messages.json`: all channel messages.
- `filedrop/channels/by-channel/{channelId}.json`: channel messages split by channel.
- `filedrop/webhooks/webhooks.json`: webhook registrations.

Production currently uses the Render persistent disk. S3 can be kept as a browsable backup/archive by running the migration endpoint or script while `STORAGE_DRIVER=local`.

## API

Set:

```sh
export BASE_URL="https://your-render-service.onrender.com"
export API_KEY="your-api-key"
```

Upload:

```sh
curl -H "Authorization: Bearer $API_KEY" \
  -F "file=@/path/to/document.pdf" \
  "$BASE_URL/api/upload"
```

List files:

```sh
curl -H "Authorization: Bearer $API_KEY" "$BASE_URL/api/files"
```

Download by API file ID:

```sh
curl -L -H "Authorization: Bearer $API_KEY" \
  "$BASE_URL/api/files/<file-id>/download" \
  -o document.pdf
```

Download links returned by upload/list can be opened directly in a browser.

Update organization metadata:

```sh
curl -X PATCH -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"project":"Taxes","path":"2026/w2.pdf","category":"Receipts","tags":"tax, 2026","commitMessage":"Add W2","note":"Uploaded from laptop"}' \
  "$BASE_URL/api/files/<file-id>"
```

Create a new version of an existing file:

```sh
curl -H "Authorization: Bearer $API_KEY" \
  -F "file=@/path/to/document-v2.pdf" \
  -F "commitMessage=Update signed copy" \
  "$BASE_URL/api/files/<file-id>/versions"
```

Project and history endpoints:

- `GET /api/projects`: list project buckets with current file and version counts.
- `GET /api/files/<file-id>/history`: list the version chain for a file.

Shared mailbox endpoints:

- `POST /api/messages`: send a message. Body: `from`, `to`, `body`, optional `project`, `relatedFileId`, `relatedUrl`.
- `GET /api/messages?to=<name>`: list messages for a recipient, including messages sent to `all`.
- `GET /api/messages?unreadOnly=true`: list unread messages.
- `PATCH /api/messages/<message-id>/read`: mark a message read.

Use `/api/messages` for control-plane coordination such as setup, status, blockers, and handoffs between trusted clients.

### Telegram job approvals via webhook

To replace Telegram `getUpdates` polling, configure the Telegram Bot API webhook to `POST /api/telegram/job-approval` and set these Render environment variables:

- `TELEGRAM_APPROVAL_WEBHOOK_SECRET`: random value supplied to Telegram as `secret_token`.
- `TELEGRAM_APPROVAL_CHAT_ID`: the single permitted Telegram chat ID.
- `TELEGRAM_APPROVAL_BOT_TOKEN`: used only to acknowledge callbacks and remove the buttons.

The endpoint accepts only `APPROVE:<approval-id>` and `REJECT:<approval-id>` callback data, validates the Telegram secret and chat, and emits a signed Filedrop `message.created` event to `job-approval-worker`. Run `npm run job-approval-receiver` on the local machine behind an authenticated Filedrop outgoing webhook/tunnel, with `TELEGRAM_APPROVAL_STATE_DIR` pointing to the job approval state directory. It writes only an idempotent approval decision; the existing local signed-in browser processor remains solely responsible for final form submission.

Conversation channel endpoints:

- `POST /api/channels`: create or update a channel. Body: `id`, `name`, optional `description`, `category`, `tags`.
- `GET /api/channels`: list channels.
- `POST /api/channels/<channel-id>/messages`: post a channel message. Body: `from`, `body`, optional `category`, `tags`, `relatedFileId`, `relatedUrl`.
- `GET /api/channels/<channel-id>/messages`: list channel messages. Query filters: `from`, `since`, `unreadOnly`, `category`, `tag`.
- `PATCH /api/channels/<channel-id>/messages/<message-id>/read`: mark a channel message read.

Use channel messages for mirrored chats, collaboration streams, and other non-control conversations. For example:

```text
channel id: collaboration-demo
channel name: Collaboration Demo
category: collaboration-sync
tags: collaboration,mirror,chat
from: collaboration-sync
```

Webhook endpoints:

- `POST /api/webhooks`: register an outgoing webhook. Body: `url`, optional `name`, `to`, `secret`.
- For channel pushes, use body fields `event="channel.message.created"` and `channelId="<channel-id>"`.
- `GET /api/webhooks`: list registered webhooks.
- `POST /api/webhooks/<webhook-id>/test`: send a test delivery.
- `DELETE /api/webhooks/<webhook-id>`: delete a webhook.

When a mailbox message is created, matching webhooks receive:

- `x-filedrop-event: message.created`
- `x-filedrop-delivery: <uuid>`
- `x-filedrop-signature: sha256=<hmac>` when a secret is configured

## No-Admin Windows Webhook Receiver

Run the receiver locally:

```powershell
$env:FILEDROP_WEBHOOK_SECRET="choose-a-shared-secret"
node .\scripts\webhook-receiver.mjs
```

Expose it with a user-space tunnel such as Cloudflare Tunnel or ngrok. For Cloudflare Tunnel, download the Windows zip, unzip it in your user folder, then run:

```powershell
.\cloudflared.exe tunnel --url http://127.0.0.1:8787
```

Register the public tunnel URL:

```sh
curl -X POST "$BASE_URL/api/webhooks" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"desktop-client","to":"desktop-client","url":"https://your-tunnel.trycloudflare.com/webhook","secret":"choose-a-shared-secret"}'
```

This receiver prints incoming events and appends them to `webhook-inbox.jsonl`.

## Connecting an API Client

Use `openapi.yaml` as the API schema. Replace the `servers[0].url` value with your Render URL, then configure bearer authentication with the `API_KEY` value from Render.

For a client that only needs to pull docs, grant it the API key and use:

- `GET /api/files` to find available documents.
- `GET /api/files/{id}/download` to fetch the selected document.

## ChatGPT Custom GPT Action

Use `chatgpt-action-openapi.yaml` for a Custom GPT Action. Configure authentication as Bearer token and paste the Render `API_KEY`.

Suggested GPT instructions:

```text
You are my private file transfer assistant. When I attach files and ask you to save, upload, transfer, or store them, call importChatGPTFiles. Ask for a category, tags, or note only when helpful. Use listFiles to find stored files. Use updateFileMetadata to organize files. Use returnFileToChatGPT when I ask to bring a stored file back into this chat.
```

## ChatGPT Custom App / MCP

The app also exposes a Streamable HTTP MCP endpoint:

```text
https://your-render-service.onrender.com/mcp
```

Configure the MCP/custom app authentication as a Bearer token and use the same `API_KEY` from Render.

Available MCP tools:

- `list_files`: find stored files and group them by day, month, or category.
- `list_projects`: list project buckets and version counts.
- `create_channel`: create or update a conversation channel.
- `list_channels`: list conversation channels.
- `send_channel_message`: post a channel message.
- `list_channel_messages`: read channel messages.
- `send_message`: post a mailbox message for another session.
- `list_messages`: read mailbox messages.
- `mark_message_read`: mark a message read.
- `register_webhook`: register a push webhook for new messages.
- `list_webhooks`: list registered webhooks.
- `delete_webhook`: remove a webhook.
- `import_chatgpt_files`: save files attached in ChatGPT into the filedrop.
- `upload_from_url`: pull a downloadable URL into the filedrop.
- `upload_new_version_from_url`: save a URL as the next version of a stored file.
- `organize_file`: update category, tags, and note.
- `get_file_history`: inspect a file's version chain.
- `get_file_link`: get the direct download link for a stored file.

Suggested ChatGPT instructions:

```text
Use my Private Filedrop MCP tools to move files between computers and coordinate with my other Codex sessions. Treat projects and paths like lightweight repos. Use send_message and list_messages as a shared mailbox for handoffs. Save attached files with import_chatgpt_files, list stored files with list_files, organize files with organize_file, upload follow-up versions with upload_new_version_from_url when I am replacing a file, inspect history with get_file_history, and give me direct links with get_file_link. Prefer categories like Work, Receipts, Personal, or Transfers when I do not specify one.
```

## Local Run

```sh
npm install
UPLOAD_PASSWORD=change-me API_KEY=dev-key npm run dev
```

Then open `http://localhost:3000`.
