# Contributing to Foreman

Thanks for taking a look. Foreman is a small, opinionated project — short PRs and sharp issues land fastest.

## Before you start

- Read [`FOREMAN.md`](./FOREMAN.md) for the architecture and [`FOREMAN-TUI.md`](./FOREMAN-TUI.md) for the brand / UI spec. Most "why is it like this?" answers are in there.
- Scan open [issues](https://github.com/tuzlu07x/foreman/issues) — labelled by phase (`phase:1-skeleton` … `phase:4-release`) and area (`area:tui`, `area:mediator`, `area:docs`, …). Pick something with no assignee.
- For anything beyond a small fix, open an issue first so we can agree on scope before code lands.

## Dev setup

```bash
git clone git@github.com:tuzlu07x/foreman.git
cd foreman
npm install
npm run lint        # tsc --noEmit
npm test            # vitest run
npm run build       # tsup
```

Run the TUI locally against an isolated home dir:

```bash
FOREMAN_HOME=./.foreman-dev node dist/cli/index.js init
FOREMAN_HOME=./.foreman-dev node dist/cli/index.js start
```

## Pull requests

- Branch off the latest `main`. Name it `feat/<issue#>-<short-slug>` or `fix/<issue#>-<short-slug>`.
- One issue per PR. Reference it in the body with `Closes #<N>`.
- Keep commits tidy. Conventional commit subjects (`feat(scope): …`, `fix(scope): …`).
- Tests, lint, and build must be green before review. The TUI has a manual smoke step — call it out in the PR body if you touched `src/tui/`.
- Match the existing patterns rather than introducing new ones. The shape of services, pages, and CLI commands is intentional — copy a neighbour.

## Issues

Good issues describe:

1. What you expected.
2. What you saw.
3. The smallest steps to reproduce.
4. Foreman version (`foreman --version`) and Node version.

For feature ideas, lead with the user story ("as a user running X, I want Y because Z"). Issues that fit the v0.1 scope (see roadmap in README) get triaged fastest.

## Code style

- TypeScript strict mode, ESM. No `any` outside test files.
- Default to no comments — names and types should carry the meaning. A single short line above a function is fine when the _why_ is non-obvious.
- No new dependencies without a one-line justification in the PR body.

## Adding an agent to the registry

The curated agent registry at [`registry/agents.json`](./registry/agents.json) is the source of truth for what `foreman agent add` can install, configure, and wire up. We accept community contributions there.

To add an agent:

1. Open a PR that touches `registry/agents.json`. Append an entry that matches the existing shape — `id`, `name`, `tagline`, `homepage`, `install` (`npm` and/or `brew`, either may be `null`), `config_paths`, `required_secrets`, `optional_secrets`, `mcp_compatible`, `supported_versions`, `min_foreman_version`. The schema lives at [`registry/schema.json`](./registry/schema.json).
2. Attach a snippet file at `registry/snippets/<id>.yaml` that the wizard injects into the agent's own config to wire it through Foreman. Use one of the existing snippets as a template.
3. CI runs `foreman registry validate` on every PR that touches `registry/`. Run it locally first:

```bash
npm run build
node dist/cli/index.js registry validate
```

4. Foreman never ships another team's binary — the `install.npm` field points at *their* package. We orchestrate, we don't repackage.

## Community

- GitHub Discussions and Issues are the main channels for now.
- Be kind. The [Code of Conduct](./CODE_OF_CONDUCT.md) applies everywhere this project lives.
