# Private Filedrop

A tiny Render-hosted file bridge for moving files between computers.

## Features

- Password-protected browser upload page.
- Unguessable public download links for individual files.
- API-key-protected upload, list, and download endpoints.
- S3 or S3-compatible storage support through `render.yaml`.

## Deploy on Render

1. Push this folder to a GitHub repository.
2. In Render, choose **New +** -> **Blueprint**.
3. Select the repo and apply `render.yaml`.
4. After deploy, open the service environment page and reveal these generated values:
   - `UPLOAD_PASSWORD`: use this in the web page.
   - `API_KEY`: use this for API access.

The blueprint uses Render's free web service plan with temporary local storage by default. Files survive ordinary requests, but can disappear when Render restarts the free instance.

For durable S3-compatible storage, set these environment variables in Render:

- `STORAGE_DRIVER=s3`
- `S3_BUCKET`
- `S3_REGION`
- `S3_PREFIX=filedrop`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`

For Cloudflare R2 or another S3-compatible provider, also set `S3_ENDPOINT` and usually `S3_FORCE_PATH_STYLE=true`.

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

## Connecting an API Client

Use `openapi.yaml` as the API schema. Replace the `servers[0].url` value with your Render URL, then configure bearer authentication with the `API_KEY` value from Render.

For a client that only needs to pull docs, grant it the API key and use:

- `GET /api/files` to find available documents.
- `GET /api/files/{id}/download` to fetch the selected document.

## Local Run

```sh
npm install
UPLOAD_PASSWORD=change-me API_KEY=dev-key npm run dev
```

Then open `http://localhost:3000`.
