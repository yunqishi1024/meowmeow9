# Cedar Chat

A local React/Vite chat client. It stores providers, API keys, agents, and chat
history in the browser's local storage.

## Run On This Computer

```bash
npm install
npm run dev
```

The dev server listens on `0.0.0.0`, so Vite will show both a local URL and a
network URL.

## Use From A Phone On The Same Wi-Fi

1. Start Cedar Chat on the computer with `npm run dev`.
2. Keep the phone and computer on the same Wi-Fi.
3. Open the network URL printed by Vite on the phone, usually like:

```text
http://192.168.x.x:5173
```

If Vite only shows a local URL, find the computer's Wi-Fi IP and open:

```text
http://<computer-wifi-ip>:5173
```

Provider settings and API keys are stored per browser, so the phone has its own
separate Cedar Chat configuration. Export/import chats from the sidebar when you
want to move history between devices.

Remote MCP servers need CORS enabled. A `localhost` MCP URL on the phone points
to the phone itself, not this computer.

## Production Preview

```bash
npm run build
npm run preview
```

For access outside your Wi-Fi, deploy the built app or expose it through a
secure tunnel such as Cloudflare Tunnel or ngrok.

## Cloud Sync

Settings → 同步 can upload and download one Cedar Chat snapshot through the
Cloudflare Worker sync endpoint. The browser encrypts the snapshot with the sync
code before upload:

```text
https://<your-worker>.workers.dev
```

Use the same sync code on every device. Press Sync to merge the local browser
snapshot with the cloud copy and upload the merged result back to R2.

## Recoverable AI Gateway

The same Worker also supports a recoverable AI streaming gateway. When a sync
endpoint and sync code are configured, OpenAI-compatible chat requests can be
proxied through:

```text
POST /ai/runs/<runId>/stream
GET  /ai/runs/<runId>
```

The Worker streams the AI response back to the browser and stores the raw stream
chunks in R2. If the browser refreshes or crashes during generation, Cedar Chat
can recover the last in-flight response from the saved `runId`.

Use only your own Worker for this mode. The Worker receives your provider API
key from the browser for each AI request so it can call the upstream provider.
