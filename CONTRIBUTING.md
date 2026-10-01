# Contributing

Thanks for your interest. Issues and pull requests are welcome.

- Use Node.js 22.19+ and npm. Run `npm ci`, then `npm run typecheck`,
  `npm test` and `npm run build`; all must pass without a Letta login.
- Keep the safety properties intact: fail-closed tool policy, exactly-once
  answers, no replay, blocking on uncertain delivery, loopback-only GUI with
  CSRF and Origin checks. Changes that touch them need tests.
- Live tests (`AI_SDK_LETTA_LIVE=1 npm run test:live`) use a local Letta
  backend and model, and a dedicated state directory. Never point them at an
  agent you care about.
- `packages/provider` is MIT-licensed work derived from Letta's provider;
  contributions there are under MIT. Everything else is Apache-2.0.
- Do not commit local state, tokens, agent or conversation IDs, or real
  conversation content.
- Keep commits focused, and describe *why* in the message.
- If a change affects a published package (`ai-sdk-letta`,
  `@ai-sdk-letta/server`, `@ai-sdk-letta/provider`), add a changeset with
  `npx changeset`. See [RELEASING.md](RELEASING.md).
