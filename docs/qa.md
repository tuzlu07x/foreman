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
| 10 | Approvals with no terminal open: the background service's gateway sends a risky call to (fake) Slack and a tap decides it; `foreman start` then attaches (TUI only), decides a call, and the Slack message is edited once; SIGTERM stops the service | partly |
| 11 | A company of agents, simulated: the startup chart run by six stand-ins (three speak ACP like Hermes, OpenClaw and ZeroClaw) under the background service. A goal from you flows CEO → CTO → engineer and CEO → CMO → CTO, and every hop runs and answers into your inbox. Agents talk in department channels, report to managers, read an all-hands. Finance reaching past the engineering head is blocked, from inside an ACP task and over MCP. An engineer's approval is reviewed by its manager (`org_recommend`) and decided by you in the attached TUI. The day's `org report` | partly |
| 12 | One runtime, several roles: two Codex and a Claude Code instance (`agent add backend --type codex`, …) next to the agents themselves. A feature flows lead → instances and between instances; each is launched with its own Foreman MCP server and role, and posts to #engineering as itself, trusted. Codex's own config is left untouched; removing an instance removes its token file | |

## Isolation

Every scenario gets its own temporary directory with its own
`FOREMAN_HOME`, `HOME` (and XDG dirs), working directory and spend port
(`FOREMAN_OTLP_PORT`). Nothing reads or writes your real Foreman state.

- `PATH` starts with stub agent CLIs (`claude`, `codex`, `hermes`,
  `openclaw`, `zeroclaw`) that print canned output and never touch files
  (scenario 11 replaces them with `qa/support/company-agent.cjs`, which
  follows a playbook and hands work on with `foreman write`);
  `npm`, `npx` and `uvx` refuse to run. Real agent CLIs are never on `PATH`.
- Every Node process preloads `qa/support/no-network.cjs`, which refuses
  any connection other than to 127.0.0.1. Each scenario asserts that
  nothing tried.
- Teardown stops `foreman start`, kills whatever the scenario left running
  and deletes the directory (`QA_KEEP=1` keeps it for debugging).

## Platform

The suite runs the same way on Linux and macOS: all nine scenarios, the
pty ones included.

- **The pty.** Scenarios 3, 4, 6 and 7, and parts of 8 and 9, drive
  `foreman start` in a 120×40 pseudo-terminal. On Linux that is util-linux
  `script`. On macOS it is `qa/support/pty-run.py`, a small helper that uses
  only Python 3's standard library (`python3` comes with the Xcode Command
  Line Tools), so QA needs no native npm package. Both pass keystrokes in,
  the screen out and Foreman's exit code through.
- **Short sandbox paths.** `foreman start` runs its daemon on a Unix socket
  in `FOREMAN_HOME`, and the socket path must be 100 characters or less.
  Sandboxes go under `os.tmpdir()` when that fits (Linux: `/tmp`). macOS's
  per-user `$TMPDIR` (`/var/folders/…/T`) is too long, so there they go under
  `/tmp/fq-<scenario>-XXXXXX` (0700, deleted on teardown). Every
  `foreman start` in QA waits for the daemon to listen, so a path that is too
  long fails the scenario. Otherwise agents would quietly fall back to the
  in-process path. Scenario 3 also checks the socket with
  `foreman doctor --json`.
- **Process checks.** Scenario 3 reads the running `foreman start`'s
  environment from `/proc/<pid>/environ` on Linux and `ps eww` on macOS.
  Zombie checks use `/proc/<pid>/stat` and `ps -o stat=` respectively.

When no pty is available (no `script` on Linux, no `python3` on macOS, or
Windows), the pty scenarios are reported as skipped with the reason.
`QA_NO_PTY=1` skips them on purpose. Scenario 8 still runs without a pty;
only its TUI approve and deny steps are skipped, with a note saying so.
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
