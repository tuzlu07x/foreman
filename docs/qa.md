# End-to-end QA (`npm run qa`)

`npm run qa` builds Foreman and runs scripted user journeys against the
built CLI (`dist/cli/index.js`), with real processes: `foreman start` in a
pseudo-terminal, agents speaking MCP to `foreman mcp-stdio`, a real upstream
MCP server, a local webhook receiver, a fake Slack and OTLP telemetry. Each journey checks
the audit trail (`foreman log tail --json`, `foreman inbox --json`,
`foreman org messages` and the SQLite database), not only exit codes.

```bash
npm ci
npm run qa
```

The report is written to `qa/out/qa-report.md` (gitignored): every scenario
with its result, duration, steps and the evidence each step checked.

## Scenarios

| # | Journey | Needs a pty |
| --- | --- | --- |
| 1 | First run: `init`, `doctor --json` without failures, `inbox` | |
| 2 | MCP hub through `mcp-stdio`: allowed call, ask → timeout, result guard, poisoned tool, rug pull, `mcp trust` | |
| 3 | Approve (`a`) and deny (`d`) in the TUI a call made by a separate agent process | yes |
| 4 | TUI console: `status`, `write codex add tests`, `approve` | yes |
| 5 | Org: template, `add-department` / `add-role`, delegation and `org_post` along the chart, per-department MCP servers | |
| 6 | Signed webhook for a critical approval; outcome in the inbox | yes |
| 7 | Spend: OTLP telemetry, `usage`, `org report`, a `--pause` budget that blocks delegation and raises an inbox alert | yes |
| 8 | Claude Code PreToolUse hook: `agent hook install claude-code`, an allowed call, ask then approve (`a`) and deny (`d`) in the TUI, fail-closed exits, a `policy.yaml` deny | partly |
| 9 | A company on Slack: Finance, Marketing and IT mirrored to their own channels; approval buttons (allow, deny, a stranger refused); a budget overrun alert that pauses Marketing; `/foreman report` and `/foreman integration disable` from Slack (owner vs. non-owner); an agent refused a cross-department hand-off and an integration change; the audit trail | partly |

## Isolation

Every scenario gets its own temporary directory with its own
`FOREMAN_HOME`, `HOME` (and XDG dirs), working directory and spend port
(`FOREMAN_OTLP_PORT`). Nothing reads or writes your real Foreman state.

- `PATH` starts with stub agent CLIs (`claude`, `codex`, `hermes`,
  `openclaw`, `zeroclaw`) that print canned output and never touch files;
  `npm`, `npx` and `uvx` refuse to run. Real agent CLIs are never on `PATH`.
- Every Node process preloads `qa/support/no-network.cjs`, which refuses
  any connection other than to 127.0.0.1. Each scenario asserts that
  nothing tried.
- Teardown stops `foreman start`, kills whatever the scenario left running
  and deletes the directory (`QA_KEEP=1` keeps it for debugging).

## Platform

Scenarios 3, 4, 6 and 7 drive `foreman start` through util-linux `script`
(Linux only). Where it is missing they are reported as skipped with the
reason. `QA_NO_PTY=1` skips them on purpose. Scenario 8 still runs without
a pty; only its TUI approve and deny steps are skipped, with a note saying so.
Scenario 9 likewise runs its setup and agent-side checks everywhere, and the
steps that need `foreman start` (and so two-way Slack) only with a pty.

## The fake Slack

Scenario 9 runs a fake Slack in the test process (`qa/support/fake-slack.ts`):
the Web API Foreman calls (`apps.connections.open`, `chat.postMessage`,
`chat.update`), the `response_url` replies, and Socket Mode as a WebSocket
the test pushes slash commands and button taps through, as a given Slack
user id. Foreman is pointed at it with `FOREMAN_TEST_SLACK_ORIGIN`, a
test-only override (`src/core/notification/channels/slack-endpoints.ts`)
that accepts exactly `http://127.0.0.1:<port>` and is ignored otherwise, so
it can't send a token or a reply off the machine. Without it, Foreman only
talks to slack.com over TLS and only replies to `hooks.slack.com` URLs.

## In CI

`.github/workflows/qa.yml` runs the suite on Linux for every pull request
that touches code, and on `main`. The report appears in the job summary and
is kept as the `qa-report` artifact for 30 days. The job needs no secrets.

## Working on the suite

```bash
npx vitest run --config qa/vitest.config.ts qa/scenarios/03   # one scenario
npx tsc -p qa/tsconfig.json                                   # type-check qa/
```

Scenarios live in `qa/scenarios/*.qa.ts`; helpers in `qa/support/`. A
scenario is one test made of `journey.step(...)` calls; the evidence lines
a step records end up in the report.
