# Changesets

Each pull request that changes a published package (`ai-sdk-letta`,
`@ai-sdk-letta/server`, `@ai-sdk-letta/provider`) adds a changeset:

```sh
npx changeset
```

Pick the packages, the bump (patch, minor or major) and write one line for
the changelog. `ai-sdk-letta` and `@ai-sdk-letta/server` are a fixed group
and always share a version. See [RELEASING.md](../RELEASING.md) and the
[Changesets docs](https://changesets.dev).
