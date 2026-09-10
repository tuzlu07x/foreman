# Foreman repository instructions

Read the root `AGENTS.md` and `CONTRIBUTING.md` before changing this project.
They are the source of truth for contribution workflow, verification, and
security boundaries.

Foreman is security-sensitive software: it mediates tool calls made by local
developer agents. Prefer minimal, focused changes; preserve fail-closed policy
and approval behavior; never add credentials, secrets, or machine-specific
data. Use Node 20+, then run `npm run lint`, `npm test`, and `npm run build`.

Before changing a directory, read the closest relevant design material:

- `FOREMAN.md` for architecture and core runtime behavior.
- `FOREMAN-TUI.md` for terminal UI changes.
- `CONTRIBUTING.md` for registry changes and PR expectations.

For work proposed from an issue, implement only its acceptance criteria. Open a
draft PR if the desired behavior or security tradeoff remains uncertain. Do not
edit workflows, release logic, install scripts, or dependencies unless the task
explicitly calls for it and the PR explains the impact.
