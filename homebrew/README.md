# Homebrew tap for Foreman

This directory hosts the canonical Foreman formula. The actual tap users `brew tap` against lives in a separate repository — [`tuzlu07x/homebrew-foreman`](https://github.com/tuzlu07x/homebrew-foreman) — so that homebrew's tap name convention (`<owner>/homebrew-<name>`) is satisfied. The release workflow ([`.github/workflows/homebrew-bump.yml`](../.github/workflows/homebrew-bump.yml)) keeps the tap repo in sync with this source of truth on every GitHub release.

## One-time tap-repo setup (owner only)

1. Create the tap repo on GitHub: **`tuzlu07x/homebrew-foreman`**, public, MIT license.
2. Initial layout:
   ```
   homebrew-foreman/
     Formula/
       foreman-agent.rb # copy of this directory's foreman-agent.rb, version-bumped
     README.md          # short note pointing at github.com/tuzlu07x/foreman
   ```
3. Mint a fine-grained personal access token with `contents: write` + `pull-requests: write` on the tap repo, save it as the `HOMEBREW_TAP_TOKEN` secret on the _foreman_ repo.

After that the release workflow handles everything.

## How the bump runs (release-driven)

On every published GitHub release:

1. The workflow downloads the npm tarball for that version from `registry.npmjs.org` and computes its sha256.
2. Re-renders `Formula/foreman-agent.rb` with the new `url`, `sha256`, and version.
3. Pushes a branch + opens a PR against the tap repo. Auto-merge is enabled if the tap's own CI (`brew test foreman-agent`) passes.

If the tap CI fails the PR stays open for manual review.

## Manual bump (in a pinch)

If the workflow is broken or you want to push a hotfix manually:

```bash
# 1. compute sha256 of the published tarball
curl -fsSL "https://registry.npmjs.org/foreman-agent/-/foreman-agent-${VERSION}.tgz" \
  | shasum -a 256 | cut -d' ' -f1
# 2. edit Formula/foreman-agent.rb in the tap repo, update url + sha256 + version
# 3. brew audit --strict --new-formula --online tuzlu07x/foreman/foreman-agent
# 4. brew test tuzlu07x/foreman/foreman-agent
# 5. commit + push to main
```

## Why ship the formula here too?

Two reasons:

1. The release workflow needs a template to render from — keeping it next to the source is simpler than vendoring it inside the workflow YAML.
2. It documents the canonical formula shape, so contributors who only want to fix a typo in `caveats` can open a single PR against `foreman` instead of bouncing between repos.
