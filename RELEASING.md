# Releasing

Three packages are published to npm:

| Package | License | Depends on |
| --- | --- | --- |
| `@ai-sdk-letta/provider` | MIT | none of the others |
| `ai-sdk-letta` | Apache-2.0 | none of the others |
| `@ai-sdk-letta/server` | Apache-2.0 | `ai-sdk-letta` |

`@ai-sdk-letta/tui`, `@ai-sdk-letta/web` and `examples/basic` are
`"private": true` and are never published (see [Not published yet](#not-published-yet)).

Versions are managed with [Changesets](https://changesets.dev).
`ai-sdk-letta` and `@ai-sdk-letta/server` are a *fixed* group: they always
share a version, because the server is a thin layer over the library and is
tested against the same commit. The provider is versioned on its own: it
shares no code with the other two and has its own license and history.

Releases are published by [`.github/workflows/release.yml`](.github/workflows/release.yml)
with **npm trusted publishing** (GitHub OIDC). No npm token is stored
anywhere. Trusted publishing can only be configured for a package that already
exists on npm, so **0.1.0 is published by hand, once**. Every later release
goes through CI.

## 1. Before the first release

- **Make the GitHub repository public.** npm only generates provenance for
  packages published from a public repository; publishing from a private one
  still works, without provenance. The `repository` field of every published
  `package.json` points at `https://github.com/leonardschneider/ai-sdk-letta`;
  npm requires it to match the publishing repository exactly.

  Settings → General → Danger Zone → Change repository visibility → Public.
  Or: `gh repo edit leonardschneider/ai-sdk-letta --visibility public --accept-visibility-change-consequences`.

  Before doing so, check that the history contains no secrets, local paths
  or private conversation content (`git log -p`, or a scanner such as
  `gitleaks detect`).
- **Allow the release workflow to open PRs.** Settings → Actions → General →
  Workflow permissions → tick "Allow GitHub Actions to create and approve pull
  requests". Without it, the Version Packages PR cannot be created.

## 2. First publish (by hand, with 2FA)

Run on your machine, logged in as the npm user that owns the `ai-sdk-letta`
org (`npm whoami`). npm prompts for a one-time password (or opens the
browser) for each publish.

The versions in `main` are `0.0.0` placeholders until the Version Packages
PR is merged. Do **not** publish them.

1. Merge the release setup PR. The release workflow opens a **Version
   Packages** PR that sets the three packages to `0.1.0` and writes their
   changelogs. Review it and merge it. The next release run sees unpublished
   versions, but **skips publishing** because trusted publishing is not
   enabled yet (the run summary says so).
2. Build and check from a clean checkout of that commit:

   ```sh
   git switch main && git pull
   git status                    # must be clean
   npm ci
   npm run typecheck && npm test && npm run build
   npm run check:packages
   ```

3. Dry run, then publish, in dependency order (`ai-sdk-letta` before
   `@ai-sdk-letta/server`):

   ```sh
   npm publish --dry-run --workspace @ai-sdk-letta/provider
   npm publish --dry-run --workspace ai-sdk-letta
   npm publish --dry-run --workspace @ai-sdk-letta/server

   npm publish --workspace @ai-sdk-letta/provider --access public
   npm publish --workspace ai-sdk-letta --access public
   npm publish --workspace @ai-sdk-letta/server --access public
   ```

   Each must report version `0.1.0`. `--access public` is required for the
   scoped packages on their first publish (it is also in their
   `publishConfig`) and harmless for `ai-sdk-letta`. Local publishes have no
   provenance; that is expected.

4. Tag the release and push the tags, so the next CI release has a baseline:

   ```sh
   git tag @ai-sdk-letta/provider@0.1.0
   git tag ai-sdk-letta@0.1.0
   git tag @ai-sdk-letta/server@0.1.0
   git push origin @ai-sdk-letta/provider@0.1.0 ai-sdk-letta@0.1.0 @ai-sdk-letta/server@0.1.0
   ```

5. Check from a scratch directory outside the repository:

   ```sh
   cd "$(mktemp -d)" && npm init -y && npm pkg set type=module
   npm install ai ai-sdk-letta @ai-sdk-letta/server @ai-sdk-letta/provider
   node -e "import('ai-sdk-letta').then(m => console.log(typeof m.defineAgent))"
   ```

## 3. Configure trusted publishing (once per package)

For **each** of `@ai-sdk-letta/provider`, `ai-sdk-letta` and
`@ai-sdk-letta/server`, on npmjs.com: package page → **Settings** →
**Trusted Publisher** → **GitHub Actions**, then enter:

| Field | Value |
| --- | --- |
| Organization or user | `leonardschneider` |
| Repository | `ai-sdk-letta` |
| Workflow filename | `release.yml` (the file name only, not the path) |
| Environment name | leave empty |
| Allowed actions | **`npm publish`** (Changesets publishes directly; staged publishing does not work with Changesets yet) |

All fields are case-sensitive, and npm does not validate them when you save:
a mistake only shows up as an `ENEEDAUTH` error at the next publish.

The same, from the command line (npm 11.15.0 or later, 2FA required, one
call per package):

```sh
for pkg in @ai-sdk-letta/provider ai-sdk-letta @ai-sdk-letta/server; do
  npm trust github "$pkg" --repository leonardschneider/ai-sdk-letta --file release.yml --allow-publish
  sleep 2
done
```

Then:

1. **Enable the publish jobs:** set the repository variable
   `NPM_TRUSTED_PUBLISHING` to `true` (Settings → Secrets and variables →
   Actions → Variables, or
   `gh variable set NPM_TRUSTED_PUBLISHING --body true -R leonardschneider/ai-sdk-letta`).
   Until then the workflow skips publishing with a notice instead of failing.
2. **Recommended:** once a CI release has succeeded, on each package's
   Settings → Publishing access choose "Require two-factor authentication and
   disallow tokens". Trusted publishing keeps working; tokens stop working.

## 4. Later releases (Changesets)

1. In each PR that changes a published package, add a changeset:

   ```sh
   npx changeset          # pick packages, bump type, one-line summary
   ```

   Commit the generated `.changeset/*.md` with the change. Changes to the
   private workspaces need no changeset.
2. On every push to `main`, the release workflow opens or updates a
   **Version Packages** PR that bumps versions, writes changelogs and syncs
   `package-lock.json`.
3. Merging that PR triggers the publish: the `pack` job runs typecheck, tests
   and build, then packs the unpublished versions; the `publish` job (the only
   job with `id-token: write`) publishes them through OIDC, with provenance
   once the repository is public, then pushes tags and creates GitHub
   releases.

Requirements this relies on (from the npm docs, checked October 2026):
npm CLI 11.5.1 or later and Node 22.14.0 or later
([trusted publishers](https://docs.npmjs.com/trusted-publishers)). The
workflow uses Node 24, which ships npm 11, and checks the npm version before
publishing. Provenance is automatic with trusted publishing; no
`--provenance` flag is needed
([provenance](https://docs.npmjs.com/generating-provenance-statements)).
Only GitHub-hosted runners are supported.

The trusted publisher is bound to the file name `release.yml`. If you rename
the workflow, update the binding on npmjs.com for every package first.

## Not published yet

- **`@ai-sdk-letta/tui`** depends on `@ai-sdk/tui` 1.0.119 plus a
  `patch-package` patch applied by *this repository's* `postinstall`. npm
  consumers would get the unpatched `@ai-sdk/tui`, and the TUI would not work.
  Options under consideration: publish a fork of `@ai-sdk/tui` under the
  `@ai-sdk-letta` scope, or wait until the changes land upstream. Until then it
  is `"private": true` and used from this repository.
- **`@ai-sdk-letta/web`** is the built browser app that `startGuiServer` from
  `@ai-sdk-letta/server` serves. It is `"private": true` for now; the server
  takes the assets directory as an argument. Follow-up: decide whether the
  built assets ship inside `@ai-sdk-letta/server` or as their own package.

To publish either later: remove `"private": true`, add the publish metadata
(see the published packages' `package.json`), replace the `*` ranges on
internal dependencies with real ones, remove it from `ignore` in
`.changeset/config.json` and from `privateWorkspaces` in
`scripts/check-packages.mjs`, publish its first version by hand, and add its
trusted publisher.
