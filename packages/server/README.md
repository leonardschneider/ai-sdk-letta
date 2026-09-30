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

License: Apache-2.0.
