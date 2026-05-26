# Cedar Chat Worker

Copy `worker/index.js` into the Cloudflare Worker online editor when you want
the R2 sync endpoint to support incremental sync.

The Worker keeps the old endpoints:

- `/sync/snapshot`
- `/sync/health`
- `/sync/blob/<id>`
- `/mcp/<target-name>`

It also adds the incremental endpoints used by the app:

- `/sync/v2/health`
- `/sync/v2/manifest`
- `/sync/v2/object?key=...`
- `/sync/v2/list?prefix=...`

And the recoverable AI streaming gateway:

- `POST /ai/runs/<runId>/stream`
- `GET /ai/runs/<runId>`
- `DELETE /ai/runs/<runId>`
- `/ai/health`

When Cedar Chat has a sync endpoint and sync code configured, OpenAI-compatible
chat requests can go through this Worker. The Worker streams the upstream AI
response back to the browser while also saving the raw stream chunks to R2, so a
browser refresh can recover the last in-flight response by `runId`.

Keep the existing Cloudflare bindings and variables, especially:

- `CEDAR_SYNC_BUCKET`
- `ALLOWED_ORIGINS`
- `MCP_TARGETS`
- `GATEWAY_BEARER_TOKEN` if you use one

Only point Cedar Chat at a Worker you control. The AI gateway receives the
provider API key from the browser for each request so it can call the upstream
OpenAI-compatible endpoint.
