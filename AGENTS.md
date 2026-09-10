# Foreman agent guide

Foreman is a local-first security gateway for developer agents. It mediates
tool calls before they run, applies policy and risk scoring, asks for approval
when needed, and retains a local audit trail.

This file is for any coding agent or automated contributor working in this
repository. Read it before proposing a change.

## Start here

1. Read `README.md` for the product and `CONTRIBUTING.md` for the contribution
   contract.
2. Read `FOREMAN.md` before changing core behavior. Read `FOREMAN-TUI.md`
   before changing `src/tui/`.
3. Find a scoped issue. Prefer issues labelled `agent-ready`, `good first
issue`, or `help wanted`. If the change is not a tiny bug fix, discuss its
   plan in an issue before editing code.
4. Work from a fork and open a pull request. Never assume direct push or merge
   permission.

## Repository map

| Area                                       | Location             | Notes                                                           |
| ------------------------------------------ | -------------------- | --------------------------------------------------------------- |
| CLI commands                               | `src/cli/`           | Keep commands small and composable.                             |
| Core policy, mediation, identity and audit | `src/core/`          | Security-sensitive: preserve fail-closed behavior.              |
| MCP transport                              | `src/mcp/`           | Treat untrusted input as hostile.                               |
| Terminal UI                                | `src/tui/`           | Follow `FOREMAN-TUI.md`; report manual smoke testing in the PR. |
| Bundled integration catalog                | `registry/`          | Keep schema, entry and snippet changes together.                |
| Tests                                      | `tests/`             | Add a focused regression test for behavior changes.             |
| User documentation                         | `docs/`, `examples/` | Commands and examples must be runnable.                         |

## Required checks

Use Node 20 or later and run the checks relevant to the change:

```bash
npm ci
npm run lint
npm test
npm run build
```

For registry changes, also run:

```bash
node dist/cli/index.js registry validate
```

Run the TUI against an isolated state directory; never point exploratory work
at a real user state directory:

```bash
FOREMAN_HOME=./.foreman-dev node dist/cli/index.js init
FOREMAN_HOME=./.foreman-dev node dist/cli/index.js start
```

## Non-negotiable security boundaries

- Do not weaken approval, identity, policy, audit, or secret-handling behavior
  to make a test or demo pass.
- Do not add real credentials, tokens, private keys, `.env` contents, or
  machine-specific paths to the repository, issues, PRs, fixtures, or logs.
- Do not change GitHub Actions, release code, install scripts, or dependency
  versions unless the issue explicitly requires it. Explain the security and
  supply-chain impact in the PR.
- Do not use `pull_request_target` with a checkout of untrusted PR code.
- Do not introduce a dependency without explaining why an existing dependency
  cannot do the job.

## Change discipline

- Make the smallest change that satisfies the issue's acceptance criteria.
- Keep one logical issue per PR. Do not mix refactors, formatting sweeps, and
  product behavior in one change.
- Use strict TypeScript and ESM. Do not use `any` outside test files.
- Follow neighboring code instead of inventing a new local pattern.
- Update documentation when an installation command, public CLI behavior,
  configuration shape, or supported integration changes.

## Pull request handoff

The PR body must state: linked issue, what changed, tests run, security impact
(`none` is acceptable), and any manual TUI verification. Mark uncertain work
as a draft rather than presenting it as ready to merge.

Maintainers review and merge every contribution. Passing CI is necessary, not
sufficient, for changes that affect security boundaries.
