# @ai-sdk-letta/server

Local HTTP runtime for [ai-sdk-letta](../ai-sdk-letta) agents. Unofficial; not
affiliated with Letta or Vercel.

- `ThreadRuntime`: durable threads and runs over one agent, NDJSON events,
  exactly-once answers, cancellation, rename and archive. A run interrupted by
  a restart blocks its thread instead of being replayed.
- `startGuiServer(definition, assetsDir, options)`: the loopback browser app
  (session cookie, CSRF, Origin and Host checks, strict CSP).
- `startApiServer(definition, options)`: the same routes behind a 256-bit
  bearer token and owner header, for server-to-server use.

Routes (under `/api` for the GUI): `GET /v1/capabilities`, `GET|POST /v1/threads`,
`PATCH /v1/threads/:id`, `GET /v1/threads/:id/history`, `GET /v1/threads/:id/view`,
`POST /v1/runs`, `GET /v1/runs/:id/events?after=N` (NDJSON), `POST /v1/runs/:id/answer`,
`POST /v1/runs/:id/cancel`.

`POST /v1/runs` takes `{ id, threadId, text, parentRunId, images? }`, where
`images` is a list of `{ mediaType, data }` (base64, no `data:` prefix).
Text may be empty when images are present. Images are validated against
`IMAGE_LIMITS` and rejected with a fixed code (`image_unsupported_type`,
`image_invalid`, `image_remote_url`: 400; `image_too_large`,
`images_too_many` (400), `images_too_large`: 413). Only this route accepts a
larger body (`RUN_BODY_LIMIT_BYTES`); others keep `BODY_LIMIT_BYTES` (24 KB)
and answer `payload_too_large` (413) beyond it. Runtime state stores each
image's type, size and SHA-256, never its bytes.

License: Apache-2.0.
