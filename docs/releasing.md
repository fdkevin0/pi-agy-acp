# Releasing

Maintainer guide for automated releases and publishing recovery. For everyday
CI checks and pull request rules, see
[CI and pull requests](development.md#ci-and-pull-requests).

## Automated release flow

Releases are managed by `release-please` (`release-please-config.json` and
`.release-please-manifest.json`) via `.github/workflows/release.yml` on Node.js
24:

1. Merging Conventional Commits (`feat:`, `fix:`, etc.) to `main` runs the
   `release-please` job, which opens or updates a release PR updating
   `package.json`, `CHANGELOG.md`, and `.release-please-manifest.json`.
2. Squash-merging that release PR (preserving its `chore(main): release X.Y.Z`
   title) creates the `vX.Y.Z` tag and GitHub Release, then triggers the
   `publish` job to run `npm run check`, `npm test`, `npm pack --dry-run`, and
   `npm publish --access public --provenance`.

Ordinary commits to `main` run `release-please` only and do not trigger
`publish`.

## Repository settings and credentials

- **GitHub Actions PR permissions:** Enable **Allow GitHub Actions to create and
  approve pull requests** in Settings → Actions → General. Without a
  `RELEASE_PLEASE_TOKEN` PAT (`contents: write` and `pull-requests: write`) in
  repository secrets, `GITHUB_TOKEN` is used; close and reopen the release PR
  after its final update to trigger `ci.yml` when branch protection requires it.
- **npm Trusted Publishing (OIDC):** Configure Trusted Publishing on npm for
  owner `fdkevin0`, repository `pi-agy-acp`, and workflow `release.yml`. The
  `publish` job grants `id-token: write` and updates npm to `^11.5.1`.
- **Token fallback:** An optional `NPM_TOKEN` repository secret supplies
  `NODE_AUTH_TOKEN` (use a granular write token with 2FA bypass if needed).

## Guardrails and recovery

- The `publish` job accepts stable semver tags (`vX.Y.Z`) matching
  `package.json` only, publishes one version at a time, and never moves an
  existing tag. Branch-based `workflow_dispatch` runs are rejected.
- Only an npm registry HTTP `404` is treated as unpublished; HTTP `200` skips
  republishing, and network, auth, or server errors stop the job.
- **Recovering a failed `publish` job** (or missing GitHub Release after npm
  publication succeeded): choose **Re-run failed jobs** on that workflow run
  (re-running all jobs on a `main` run skips `publish` once the tag exists), or
  run:

  ```sh
  gh workflow run release.yml --ref vX.Y.Z
  ```

  GitHub Releases are created only for existing tags via
  `gh release create --verify-tag`. Manual tag pushes (`vX.Y.Z`) also trigger
  `publish` but bypass `release-please`, leaving `CHANGELOG.md` and
  `.release-please-manifest.json` out of sync.
