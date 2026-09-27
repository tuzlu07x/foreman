# Releasing Foreman

A release is one GitHub release. Publishing it starts three workflows:

| Workflow | What it does |
| --- | --- |
| `release-npm.yml` | Checks the tag matches `package.json`, runs lint, build and tests, then publishes `foreman-agent` to npm **with provenance**. |
| `release-binaries.yml` | Builds the four standalone binaries, each on a runner of its own architecture, smoke-tests them, and attaches them with `SHA256SUMS`. |
| `homebrew-bump.yml` | Waits for the npm release, then opens a PR on `tuzlu07x/homebrew-foreman` with the new formula. |

All three run only on a published release or a manual dispatch, never on pull requests, and every action is pinned to a commit SHA.

## One-time setup (maintainers)

1. **npm token.** Create an npm **granular access token** with publish rights for `foreman-agent` only. Add it as the secret `NPM_TOKEN` in a GitHub environment called `npm` (Settings → Environments). Add yourself as a required reviewer there if you want to approve each publish.
2. **Homebrew tap token** (optional). Add `HOMEBREW_TAP_TOKEN`, a fine-grained PAT with contents and pull-request write access on `tuzlu07x/homebrew-foreman` only. Without it, the formula is kept as a workflow artifact and no PR is opened.

## Cutting a release

1. Update `package.json` `version` (e.g. `0.2.0`), then run `npm install --package-lock-only` so the lockfile matches.
2. In `CHANGELOG.md`, move **Unreleased** under `## [0.2.0] - <date>`.
3. Merge that as a PR. `verify` and `qa` must be green.
4. Create the release from `main`:

   ```bash
   gh release create v0.2.0 --target main --title "v0.2.0" --notes-file <notes.md>
   ```

   The tag must be `v` + the `package.json` version, otherwise `release-npm` stops before publishing.
5. Watch the three workflows in the Actions tab. Then check:
   - `npm view foreman-agent version` shows the new version, and the npm package page shows a **provenance** badge;
   - the release has four binaries and `SHA256SUMS`;
   - the tap PR is open.

## Dry runs

- **npm:** Actions → `release-npm` → Run workflow. `dry_run` defaults to on: it runs every check and `npm publish --dry-run --provenance`, and publishes nothing.
- **Binaries:** Actions → `release-binaries` → Run workflow. It builds and smoke-tests all four binaries and writes `SHA256SUMS` as workflow artifacts; nothing is attached to a release.

## If something goes wrong

- **Tag and version don't match:** delete the release and the tag, fix `package.json`, then release again.
- **A binary job fails:** fix it on `main`, then re-run the failed job, or run the workflow by hand and upload the files with `gh release upload`.
- **A bad version reached npm:** prefer `npm deprecate foreman-agent@<v> "<why>"` plus a patch release to `npm unpublish`, which breaks anyone who pinned it.
