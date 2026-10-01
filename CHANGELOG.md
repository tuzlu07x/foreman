# Changelog

All notable changes to Foreman are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [2.3.1] - 2026-09-30

### Added

- **Ask Foreman for work in plain words, and approve the plan once.**
  "Analyse github.com/x/y as a team" in Telegram, Slack, Discord or the
  TUI chat gets an answer like a colleague's: who does what, from your org
  chart, what runs each role and what the team did lately. Foreman sends
  the whole plan as one approval; on Allow each part is assigned as yours,
  exactly like `/foreman assign`, and "Plan handed out" comes back where
  you asked. Nothing starts before you allow it, and agents relaying the
  chat never get plans. The chat remembers the last few messages for 30
  minutes and can quote or summarise the latest reports.
- **Open one role yourself** (`open <role>` in the CLI): the role's
  Claude Code or Codex starts in your terminal as that role, with its own
  Foreman identity, its role and its model, and Foreman's hook holds it
  to the role's permissions.
- **The Team page is managed by department.** Roles are listed under
  their departments (fold one with `←→` or Enter), with the roles in no
  department last, and each row shows the role's title, id, what runs it
  and its model: the one set in Foreman, else the agent's own setting
  (`gpt-6-luna (Codex's setting)`), else `default model`. Without opening a
  role: `x` removes it (after asking; its reports move to its manager, the
  department's next role leads if it was the lead, and its own instance is
  unregistered), `r` switches it between Claude Code and Codex, and `m`
  picks its model (the agent's own, the provider's usual models, or one you
  type). On a department's header the same keys act on all its roles and
  ask first. Each change is written to `org.yaml` and the registry at once
  and recorded in the audit log.

- **Departments in the setup wizard's Your team step and on the Team
  page.** **+ Add a department…** (or `d` on the Team page) adds a
  ready-made department (IT: backend, frontend and devops developers;
  Marketing: a marketing manager, a content creator and social media;
  Customer Support: a support lead and a support agent) or your own, and
  asks whether Claude Code or Codex runs it. On a department's row, Space
  picks all its roles, `r` switches all of them between Claude Code and
  Codex, and `x` removes it; your own roles can join a department. The
  department's first role leads it and reports to the Manager (or you);
  the rest report to the lead. If the lead's agent can't be added, the
  next role leads instead, and no one is left reporting to a role that
  wasn't added. `foreman org roles` lists the new roles grouped by
  department.
- **Which agent runs each role is easier to see and change.** The team
  picker shows Claude Code or Codex in its own column, highlighted on the
  row under the cursor, and the footer always shows `[r] Claude Code ⇄
  Codex` when both are registered. The step's result and the Done screen
  list each role with what it runs on.

### Changed

- **Two short messages per task.** A task says "handed to …" and then
  its result, nothing else: no started / progress / "✓ 01M3QR success"
  pushes, and never the agent's error output (it reached 50 000
  characters). A failure says the reason in one line and what to do in
  the next, for sign-in (401), usage limits, a model the version or
  account can't use, Codex's trusted-folder check, a permission prompt
  nobody can answer, a missing program and timeouts. In Turkish when you
  wrote the task in Turkish.
- **`/foreman model` shows what really runs.** Each role with its
  program, version and model (set in Foreman, or the agent's own
  setting, instead of "(agent default)"), the updates the last check
  found, and one quick-switch block per program, on every chat app.
- **Trusting an agent is safer.** A trusted Codex role may write in its
  folder, still sandboxed, with the network only when its role allows
  it; it never runs without Codex's sandbox. A Claude Code role skips
  Claude Code's own prompts when Foreman's hook guards it. Trust and
  untrust now say what the role may do.
- **Each role works in its own folder** (`~/foreman-work/<role>`) when a
  task names none.
- **A greeting gets a short hello**, and the same failure isn't repeated
  in full on every message. "Write the notes as a team" is read as a
  sentence, not as a hand-off to an agent called "the".
- **The setup wizard says which value you pasted.** Slack and Discord
  settings pages show several look-alike values. Pasting Slack's
  app-level token (`xapp-…`), Discord's Application ID, Public Key or
  Client Secret, or a Telegram chat id as the bot token (or the other way
  round) now says what it is and where the right value is, for example
  *that's the Public Key, not a Discord bot token: the bot token is under
  discord.com/developers → your app → Bot → Reset Token → Copy*.
- **Approval messages say who wants to do what.** A Telegram, Slack or
  Discord approval used to start with *Risk score: 100/100 (critical)*
  and the raw arguments, and after its countdown refreshed the title was
  gone too. It now starts with a plain line such as *manager wants to run
  a shell command* or *claude-code wants to read a file*, followed by the
  risk, the reasons and the arguments as before.
- **The setup wizard can make Slack two-way.** After the Slack bot token
  and channel, the Services step asks (optionally) for the app-level token
  (`xapp-…`) and your Slack member id. Give both and Allow / Deny buttons
  and `/foreman` work in Slack right after setup, as with
  `foreman notify slack-interactive`. Skip them and Slack only posts; a
  re-run that skips them keeps the two-way settings you have.

### Fixed

- **A Codex role runs as itself.** Codex merges `-c` settings into its
  own `config.toml`, so a Codex role presented plain Codex's identity
  token and ran as `untrusted:<role>`: its reports went to you instead of
  its lead. It now proves its own identity.
- **Codex and Claude Code roles can hand work on and report.** Claude
  Code refused Foreman's own tools in a task, and a sandboxed Codex
  refused them as needing an approval nobody could give. Both now use
  Foreman's tools without asking; Foreman mediates each call itself.
- **Reports to you reach Telegram, Slack and Discord**, not only the TUI
  inbox. An unverified sender is labelled as unverified.
- **Agent updates use the npm that installed the agent.** A Codex
  installed by Homebrew's Node is updated in place instead of a second
  copy under nvm's npm that the old one kept shadowing, and its version
  is read from the copy Foreman runs.
- **No API key on a subscription.** Foreman no longer writes the
  Anthropic key into Claude Code's settings when you picked the Claude
  subscription, and removes the one it wrote before.
- **Fewer false alarms.** Several Claude Code windows at once no longer
  count as one runaway loop, and a commit message, PR body or file that
  mentions a Foreman command is no longer treated as running it (one
  hidden in a heredoc now is).
- **Installing or removing the hook says** that open Claude Code
  sessions keep their old hooks until you reopen them.
- **Telegram messages sent while Foreman was off are not acted on**; one
  note says how many were skipped. Command replies no longer open a
  link-preview card for every URL.
- **Work an agent hands off comes back to it.** Headless agents run once
  per task, so a lead that delegated had finished by the time its
  delegate reported, and the chain stopped there: nobody compiled the
  answer for you. Once everything an agent handed off during a task is
  back (or failed, with the reason), Foreman launches it again, once, with
  all the results and its original task, and asks it to report to its
  manager with `org_report`. Chains unwind level by level up to you. At
  most 5 relaunches per task, never for an agent's own result or a
  blocked agent; each is an ordinary audited task (`delegation_wake`)
  with budgets and approvals as usual ([docs/org.md](docs/org.md#when-work-comes-back)).
- **Delegation nudges go to the agent that owes the answer, not to your
  chat.** The watchdog sent *nudge 2/3* and *Multi-agent loop stuck* to
  your Telegram. An answer owed for 30 minutes is now asked of the agent
  itself (at most twice), then you get one message saying who hasn't
  answered whose task and what to reply.
- **A role remembers what it did recently.** Each launch starts with the
  agent's last 5 tasks and how they ended, and the latest reports and
  direct messages to its role (bounded, secrets redacted, marked as
  information, not instructions).
- **A decided approval says where it was decided.** The chat message
  ended with *✗ Denied (resolved elsewhere)*. It now says *in the TUI*,
  *on Slack by U0123ABCD*, *on Telegram*, *relayed from hermes's chat*,
  *timed out* or *request withdrawn*.
- **A failed task no longer reads "finished your task".** A task an agent
  couldn't finish (for example a 401 from its provider) was reported as
  *Claude Code finished your task … Exit code: 1*. It now reads
  *manager (Claude Code) couldn't finish your task* with the first line
  of the error (*Failed to authenticate. API Error: 401*) before the task,
  and every task message names the role that ran it with its program in
  parentheses.
- **The daily summary no longer tells you to turn on smart analysis when
  it is on.** When Foreman's LLM failed (a usage limit, the provider
  down), the digest said *Smart analysis is off. Enable with
  `foreman llm enable`*. It now says *Smart analysis failed this time*
  with a short reason; the enable hint stays for when it really is off.
- **The setup wizard's Done screen lists roles it couldn't create.** When
  the Your team step couldn't create a role (10 of 11 created), the reason
  was only on that step's result screen. Done now lists each one, e.g.
  *✗ Code Reviewer — (the reason) · add it later with `foreman org add-role`*.
- **`foreman doctor` checks a subscription sign-in instead of guessing.**
  `provider_mapping` warned *uses OAuth (run `claude auth login` if not
  done)* for Claude Code and Codex even right after a sign-in. It now runs
  the route's verify command from the registry (`claude auth status`,
  `codex login status`) with a 5-second limit and never prints its output:
  ✓ when it passes, a warning only when it fails, a plain note when it
  can't run ([docs/doctor.md](docs/doctor.md)).
- **Claude Code's hook says how to get out when Foreman is gone.** With
  Foreman's package removed, the hook blocks every Claude Code tool call
  (it never lets one through unguarded) and said *Run: foreman doctor*,
  which is gone too. It now says to reinstall Foreman (`npm install -g
  foreman-agent`) or remove Foreman's entry under `hooks.PreToolUse` in
  Claude Code's `settings.json`. Run the hook install again to get the new
  text into an existing hook.
- **Activity rows no longer draw over each other.** With more rows than
  the Home page had room for, each two-line row was squeezed into one, so
  a row's status line landed on the next row and cut off its time and
  agent (*id=6anager: why don't you share…*). The feed now drops its
  oldest rows at the bottom instead, and the Team and Next steps box under
  it keeps its lines. On a wide terminal the rows are fitted to the feed's
  column, not the whole terminal, so a long path keeps its file name.
  Rows are measured in terminal columns (an emoji or a CJK character takes
  two), and a line break in an agent's message, an inbox notice or a
  role's instructions shows as ⏎ instead of starting a new line.
- **An API key in Claude Code's settings no longer hides behind your
  subscription.** An `env.ANTHROPIC_API_KEY` in Claude Code's
  `settings.json` wins over the Claude subscription you chose for it, so a
  revoked key failed its tasks with *401 API key is invalid*. `foreman
  doctor` now warns (`claude_subscription`) when claude-code is on the
  subscription route and that key is set, and says to remove it. It only
  reads the file and never shows the key.
- **`install.sh --uninstall` never leaves Claude Code blocked.** It now
  removes Foreman's Claude Code hook before the package, even when Claude
  Code wasn't a registered agent, and says what to delete by hand when it
  can't.
- **`install.sh` switches to the Node 22 nvm already has.** It said *Node
  22 LTS not detected — installing* when nvm had Node 22 that just wasn't
  active; it now says so and switches to it without reinstalling. Its
  *Next* list starts with `nvm use 22` when it switched Node (the terminal
  that ran it keeps the old one). The `[Y/n]` question for the nvm default
  takes an answer with spaces or a Windows line ending, and a failing
  `nvm alias default` prints the command to run instead of ending the
  installer.

- **The setup wizard shows Claude Code and Codex after a subscription
  sign-in.** Choosing your Claude or ChatGPT subscription in Step 1 (sign
  in when setup ends) instead of pasting an API key left the Agents step
  with only *Generic MCP server*: it counted a provider as set up only
  when a key was stored. A subscription chosen in Step 1 now counts, in
  the agent list and in each agent's LLM choice, as it already did for
  Foreman's brain.

## [2.3.0] - 2026-09-29

### Security

- **`rm -rf /` and friends are refused outright.** A recursive delete of
  `/`, `~`, `$HOME`, `/usr`, `/etc`, `/var` or `/boot`, `mkfs` or `dd`
  onto a disk, and a fork bomb used to ask for your approval (and were
  denied only when nobody answered). They are now denied at once
  (`risk:critical`), whatever `policy.yaml` allows. An explicit
  `buckets.critical` in `policy.yaml` still decides for itself
  ([docs/detection.md](docs/detection.md)).

- `foreman agent add` no longer prints the agent's private key. Nothing in
  Foreman uses it (agents authenticate with their identity token), and a
  key on screen ends up in scrollback and pasted chats. `--key-out <file>`
  still writes it (0600) ([#726](https://github.com/tuzlu07x/foreman/issues/726)).
- **Claude Code's hook no longer fails open when Foreman isn't on its
  PATH** ([#714](https://github.com/tuzlu07x/foreman/issues/714)). The hook
  was written as a bare `foreman-hook claude-code`. When the PATH Claude
  Code runs with lacked it (another nvm default, Foreman uninstalled, Node
  moved), the shell exited 127, which Claude Code treats as a non-blocking
  error: the tool call ran unguarded. The hook now names Node and
  `hook.js` by absolute path, and a wrapper turns any exit other than 0
  (allow) or 2 (block) into a block with *Foreman's hook could not run*.
  `foreman agent hook install claude-code` rewrites an existing entry in
  place, so run it once after upgrading. `foreman doctor` warns about a
  hook that relies on PATH (`claude_hook`).

### Added

- **A Team page in the TUI** (`t`): your org chart as a tree, with who
  fills each role, on what (Claude Code, Codex…), what it may do and who
  it reports to. `n` adds a role there, ready-made or your own, as in
  the setup wizard ([#739](https://github.com/tuzlu07x/foreman/issues/739)).
- **Chat with Foreman in the TUI** (`c`). The *Test* tab was a developer
  tool (send a test call as an agent); the tab is now a chat with
  Foreman: plain questions like `report me` or commands like `write` and
  `approve`, the same as the `:` console. The test console is still
  there with `:open test`.
- **Home says what to do next**: a Team line (`Acme · 5 roles in 2
  departments`) and the setup steps still open (connect your phone,
  install the background service, add roles), each with its command.
- **Set up your team in the setup wizard.** A new optional step, *Your
  team*, comes after install when Claude Code or Codex is registered:
  tick ready-made roles or add your own (a title, what it does in your
  own words, and what it may do), pick Claude Code or Codex for each,
  and Foreman adds each role as its own instance and writes them to
  `org.yaml`, with everyone reporting to the manager when you pick one.
  Setups finished before this step aren't sent back to it ([#736](https://github.com/tuzlu07x/foreman/issues/736)).
- **Ready-made roles, your own roles, and what each role may do.**
  `foreman org roles` lists ready-made roles (manager, developer,
  code-reviewer, researcher, writer, analyst, support, assistant).
  `foreman org add-role <id> --preset researcher --runs-on claude-code`
  adds one, filled by a new Claude Code or Codex instance named after the
  role; `--describe "…"` makes your own, in your own words. The agent is
  told the role's instructions when Foreman hands it work. A role's
  `can` (`--can read,write,shell,network`) limits what its agent may do
  with its own tools: a reviewer that may only read is refused a file
  edit (`org:role`), whatever `policy.yaml` says, and told why. Claude
  Code instances are held to their own role by the hook
  ([#734](https://github.com/tuzlu07x/foreman/issues/734)) ([docs/org.md](docs/org.md#roles-ready-made-your-own-and-what-each-may-do)).
- **Several roles on one agent.** `foreman agent add backend --type codex`
  (or `--type claude-code`) adds another instance of the agent for another
  role, and it now works as its own agent. When Foreman hands it work, it
  runs Codex or Claude Code as that instance: with its own Foreman MCP
  server for that run, and its identity token in an owner-only file,
  never on the command line. It is also told its org.yaml role. What it
  posts and hands on is attributed to it, as trusted.

  Before, work given to `backend` never ran: the program was looked up by
  name. `agent add` also rewired the agent's own config to the new name,
  taking that identity from the agent. The agent's config is now left
  alone by `agent add`, `agent rewire` and `doctor` ([#732](https://github.com/tuzlu07x/foreman/issues/732))
  ([docs/org.md](docs/org.md#several-roles-on-one-agent)).
- **Approvals reach your chat with no terminal open.** The background
  service (`foreman service install`) now runs the whole headless gateway,
  not just the daemon: approvals go to the channels routed in
  `notify.yaml` and your taps come back (the Telegram approval bot, Slack
  Socket Mode, the Discord Gateway), and `/foreman` from chat, schedules,
  the daily digest and budget alerts run there too. Before, all of that ran
  only while `foreman start` was open, and a call that needed your OK with
  the TUI closed waited unseen until it was denied
  ([docs/mcp-hub.md](docs/mcp-hub.md#run-the-daemon-at-login-foreman-service)).
- **`foreman start` attaches to the running service.** Exactly one gateway
  runs per home. With the service up, `foreman start` runs the TUI only
  (the header says *attached*): approvals show
  and are decided there, each is sent to chat once, and quitting the TUI
  leaves the service running. A service started while `foreman start` runs
  waits and takes over when it quits.
- `foreman service status` and `foreman doctor` (a new `gateway` row) say
  which process runs the gateway; doctor says where approvals go, and warns
  when the gateway stopped checking in.
- `foreman agent hook install|uninstall claude-code --project [dir]`: the
  hook in `<dir>/.claude/settings.json`, for one project only.

### Changed

- The TUI's tab bar shows every page: on two rows when one isn't wide
  enough (80 to ~150 columns). Before, at 120 columns the pages after
  Keys were hidden. The *Keys* tab is now called *Secrets*, like its
  page.

- **A new mascot** ([#724](https://github.com/tuzlu07x/foreman/issues/724)). The boot screen and the setup wizard's welcome show a
  small pixel-art beaver foreman with a hard hat, drawn with coloured
  spaces. It is 20 columns wide in every terminal and font: the old one
  used block glyphs whose width varies by terminal, or needed the optional
  `chafa`. It draws itself row by row at boot and blinks now and then. A
  terminal without colour (`NO_COLOR`) shows none. `chafa` is no longer
  used, so `foreman doctor` no longer warns that it is missing.
- **One Telegram bot is enough** ([#716](https://github.com/tuzlu07x/foreman/issues/716)).
  When no registered chat agent (Hermes, OpenClaw) can use your Telegram
  bot, Foreman reads it itself. The same bot then carries notifications,
  approval buttons and `/foreman`. Before, approving from Telegram or
  talking to Foreman there needed a second bot. With a chat agent on the
  bot, nothing changes, and the approval bot is still how you approve.
  `listener: foreman | agent` under `channels.telegram` overrides the
  choice, and `foreman doctor` shows it (`telegram (one bot)`).
- Plain messages to a bot Foreman reads are questions for Foreman
  (`report me`, `what is claude-code doing?`), from your own chat only.
  Plain text only reads: `stop`, `write …` or `integration disable …` run
  only when typed with `/foreman`.
- `/foreman report` and `report me` give today's company report when
  Foreman's LLM is off, over budget or failing, instead of an error, from
  Telegram, Slack, Discord and the TUI alike.
- The pidfile (`foreman.pid`) records which kind of Foreman holds the home
  (`tui` or `headless`) on a second line and is refreshed every 5 seconds;
  a pidfile left from before a reboot, or whose pid now belongs to
  another program, no longer counts as a running Foreman.
- **The TUI's Policy page says what each rule does in plain words**:
  "Ask before reading secret files (.env, *.key, SSH keys, …)" instead of
  `ASK if path ~ /(^|/)\.env(\..*)?$/`. The agent and tool follow on the
  row, and `Enter` still shows the raw pattern. Rules work as before.
- **The Services page lists only chat apps** (Telegram, Slack, Discord),
  each with how it is set up: Telegram as *one bot* (Foreman reads it) or
  *chat agent reads it*, Slack and Discord as *two-way* or *notifications
  only*, and `Enter` shows the command that changes it. GitHub, Jira and
  Notion are on the Integrations page.
- **The Providers page shows how each provider is connected**: API key,
  Claude / ChatGPT subscription sign-in, or endpoint (Ollama,
  OpenAI-compatible). A provider you only signed in to no longer looks
  unconfigured.
- **The Settings page is easier to read**: file paths show your home
  folder as `~` and are shortened to fit the terminal, and the chat-agent
  setting says what it means ("none picked — every chat agent using it
  gets the token") instead of "all agents receive secrets".

### Fixed

- **The TUI's Delegations table lines up.** Status and age no longer run
  together (`awaiting2m`) and `spawn-error` no longer wraps: every column
  has a fixed width and cuts its text, so a row is one line at 80 and 120
  columns. A hand-off whose agent could not run (spawn error, non-zero
  exit, timeout) now shows as `failed` instead of `awaiting`, in the TUI
  and in `foreman delegations list`.
- **Long file paths no longer break TUI rows.** In Activity, Logs and the
  approval prompt a long path is shortened in the middle, with your home
  folder as `~` (`~/…/tuitour/.env`), so each row stays one line and the
  file name stays in view. The full path is still in the inspect view
  (`i`).
- **The inbox no longer fills up with the same crash.** An agent whose
  program isn't installed (exit 127) added "hermes crashed" again on
  every start. The same crash notice isn't added again while the last
  one is unread (every crash is still in the audit log), and identical
  notices show as one row with a count (`×4`) and the latest time.
- With one Telegram bot (Foreman reads your main bot), a rejected token
  or another program reading the bot is now reported about *your Telegram
  bot*, not an "approval bot" you don't have.
- The inbox note about approvals that timed out while Foreman wasn't
  running no longer tells you to "start `foreman start` to approve" when
  you are already in it; it says to keep `foreman start` or the
  background service running to be asked next time.
- Running `foreman setup` again no longer wipes two-way chat settings: a
  channel it rewrites keeps what the wizard doesn't ask about (Slack's
  `app_token_ref`, `allowed_user_ids`, `owner_user_ids`, Telegram's
  approval bot, `listener`).
- `/foreman activity` no longer says "6s ago ago".
- **A task given to an ACP agent (Hermes, OpenClaw, ZeroClaw) keeps its
  reply** ([#729](https://github.com/tuzlu07x/foreman/issues/729)). They
  stream the answer as `agent_message_chunk` updates and end the prompt
  with only `{ stopReason }`, so the inbox showed `{"stopReason":
  "end_turn"}`. The streamed text is now the task's output. The agent
  also runs as itself, like any spawned task: `FOREMAN_SPAWNED_BY`,
  `FOREMAN_SPAWN_DEPTH` and the telemetry env are set. Before, a
  `foreman write` from inside it counted as you, so it skipped the org
  chart and budget checks.
- **The setup wizard's Services step no longer saves a wrong paste.** A
  value that fails its format check (a Discord public key pasted as the
  bot token) was stored at once with *Saved anyway*. Now the prompt stays
  and asks you to press Enter again to keep it, or to paste the right
  value; empty input still skips.
- **The wizard no longer turns on a chat app it can't send to.** A
  skipped token, chat id or channel still left Telegram, Slack or Discord
  `enabled: true` in `notify.yaml` with only `bot_token_ref`, and
  `foreman doctor` warned. A chat app is enabled only when its token and
  its chat id or channel are set (this run, or already stored); otherwise
  it is left off and the summary names the command that finishes it.
- **The wizard asks where Slack and Discord bots post.** After the Slack
  bot token it asks for the channel (default `#foreman`; invite the bot
  with `/invite @yourapp`), after the Discord bot token for the channel id
  (17–20 digits, via Developer Mode → *Copy Channel ID*), and writes it as
  `channel` in `notify.yaml`, like `foreman notify enable slack|discord
  --channel`. Before, both channels were enabled without one and could not
  be built.
- A Slack or Discord set up in the wizard now receives approvals, alerts
  and the digest: the default routing named Telegram only, so nothing was
  sent to them until `foreman notify route …`. A channel you already
  routed keeps your routing.
- **Setup: an API key is never swapped for a browser sign-in.** For
  Anthropic and OpenAI, Step 1 asked "Sign in with your subscription
  instead of pasting a key? (y/n)", and Enter meant yes. A key pasted at
  that question was dropped, a browser sign-in was queued, and the
  summary said "0 LLM providers". It is now an explicit choice with
  **API key** highlighted. A key saved in the run sets `auth_mode:
  api_key` and cancels a queued sign-in for that provider. Going back
  (Esc, or `n` on the summary, which used to continue like `y`) keeps
  your ticks and asks again. The Done screen counts subscriptions as
  providers ([#720](https://github.com/tuzlu07x/foreman/issues/720)).
- Setup: Step 2 (Foreman's brain) shows, on each ✗ row, why it can't be
  picked yet ("needs an OpenAI key or ChatGPT sign-in in Step 1"). A
  custom OpenAI-compatible provider picked in Step 1 is now written to
  `llm.yaml`. The Done screen says where to talk to Foreman: `:` in the
  TUI, your Telegram bot, `/foreman` in Slack or Discord.
- **The install script no longer reports success when new terminals can't
  find `foreman`.** When it has to switch to Node 22 through nvm while your
  nvm default is an older Node (for example 20), it says so and, in a
  terminal, asks whether to make Node 22 your default. It never changes it
  unasked (`FOREMAN_NVM_DEFAULT=1` / `=0` decide ahead).
- **`install.sh --uninstall` removes Foreman, not just the package.** It
  removes the background service and each agent (their `foreman` MCP entry
  and Claude Code hook go with them), then the package, then asks before
  deleting Foreman's data (`--purge`: without asking). It finds a Foreman
  installed under another nvm Node than your shell's, and tells you to use
  `brew uninstall` for a Homebrew one. Before, only `npm uninstall` ran,
  under the shell's Node, which could leave everything behind.
- docs/install.md: Homebrew 7 needs `brew trust --formula
  tuzlu07x/foreman/foreman-agent` before `brew install`
  ([#718](https://github.com/tuzlu07x/foreman/issues/718)).

## [2.2.0] - 2026-09-29

Foreman keeps guarding when the TUI is closed, can run its own model locally,
and covers Claude Code's own tools from the first setup. Upgrade notes: nothing
breaks; `foreman service install` is optional, and setup now asks before adding
Claude Code's hook.

### Added

- **Foreman's brain can run on Ollama or any OpenAI-compatible
  endpoint.** Verification and daily summaries used to need Anthropic,
  OpenAI or Gemini; the `ollama` and `openai_compatible` providers in
  `llm.yaml` now have a client (OpenAI Chat Completions over `fetch`, no
  new dependency). In `foreman setup` Step 2 the Ollama and Custom rows are
  no longer "(not supported yet)": Ollama asks for its base URL (default
  `http://localhost:11434`) and lists the pulled models; Custom offers the
  presets (DeepSeek, OpenRouter, Groq, …) and your own endpoint (base URL,
  optional key, model from its `/models` list). Ollama calls cost $0; an
  OpenAI-compatible endpoint is billed at the most expensive known price so
  the budget is never under-counted. Base URLs must be http(s), redirects
  are refused so the key only goes to the configured endpoint, and
  `foreman doctor` checks the URL
  ([docs/llm-providers.md](docs/llm-providers.md#foremans-brain-on-ollama-or-an-openai-compatible-endpoint)).
- **`foreman service install | uninstall | status`: the daemon at login**
  ([docs/mcp-hub.md](docs/mcp-hub.md#run-the-daemon-at-login-foreman-service)).
  Agents and the hook no longer need `foreman start` or `foreman daemon`
  open in a terminal to use the daemon.
  - macOS: a LaunchAgent (`~/Library/LaunchAgents/dev.foreman.daemon.plist`)
    in your `gui/<uid>` domain, restarted on a crash, logging to
    `<state dir>/daemon.log`. Linux and WSL2: a systemd user unit
    (`~/.config/systemd/user/foreman-daemon.service`). Without systemd
    (common on WSL) `install` says so and changes nothing. Native Windows
    isn't supported.
  - It runs the absolute paths of the Node binary and Foreman CLI you
    installed it with, with your `FOREMAN_HOME` and PATH. Run `install`
    again after upgrading Node or Foreman; `status` warns when a path is
    gone.
  - `foreman start` works alongside it: agents stay on the running daemon,
    and their approvals still appear in the TUI (they go through the
    database). When `foreman start` got there first, the service waits and
    takes over when it quits.
  - `foreman daemon --service` (what the service runs) exits 0 instead of
    being restarted in a loop when it can't start for a reason a restart
    won't fix.
  - `foreman doctor`'s `daemon` row warns when the service is installed but
    the daemon isn't running.
  - The service file is 0644 in your own directory, never written through a
    symlink or outside your home directory. The daemon's socket and token
    are unchanged.

- **The setup wizard adds Claude Code's PreToolUse hook.** Claude Code's
  own tools (Bash, Edit, Write, Read, WebFetch…) only went through
  Foreman once you ran `foreman agent hook install claude-code`, a step
  the wizard never mentioned. The agents step now asks "Also check Claude
  Code's own tools before they run? (recommended)" — yes by default — and
  the install step adds the hook to `~/.claude/settings.json`, keeping
  every other setting and hook. Say no and the Done screen still shows the
  command.

### Changed

- Tests run with a throwaway `HOME` as well as `FOREMAN_HOME`, so no test
  can edit the developer's real Claude Code or Codex settings.

### Fixed

- **The audit log names who decided an approval in Slack or Discord.**
  With several people in `allowed_user_ids`, `requests.decided_by` only
  said `user:slack` and the inbox said "by you via Slack", whoever tapped.
  It is now `user:slack:<member id>` / `user:discord:<user id>` (e.g.
  `user:slack:U0BOSS`), carried across processes in a new
  `pending_approvals.resolved_user` column (migration 0029), and the inbox
  says "by U0BOSS via Slack". TUI and Telegram decisions are unchanged
  (`user:tui`, `user:telegram`); readers that match the `user` prefix
  (log filters, the previously-denied risk rule, the inbox) need no change
  ([docs/notifications.md](docs/notifications.md#3a-two-way-slack-and-discord)).
- **`foreman notify slack-interactive --off` and `discord-interactive
  --off` also remove `owner_user_ids`.** They removed the token reference
  and `allowed_user_ids` but left the owners behind, so turning two-way
  mode back on later quietly brought back an old owner list and, with it,
  who may change integrations from chat.

### Security

- **The Gemini API key no longer appears in the setup wizard's error
  text.** Listing Gemini models sent the key as a `?key=` URL parameter,
  and a failed request's message quoted that URL, so an unexpected HTTP
  status (e.g. 400) could show the key on screen. The key now goes in the
  `x-goog-api-key` header, as the Gemini client already did, and model
  discovery errors never include a URL's query string.


- **Refused Slack and Discord interactions are audited.** A button tap or
  `/foreman` from someone not in `allowed_user_ids` was refused but left
  no trace. Each refusal now writes a `notify:interaction-refused` audit
  event with the platform, the user id and what was tried
  (`button:<action>` with the approval id, `command:<verb>` or
  `command:other`); never the message text or the button's tag. At most
  one event per user per minute (the next carries `suppressed`) and 30 per
  minute in all, so a flood can't grow the log without bound
  ([docs/notifications.md](docs/notifications.md#3a-two-way-slack-and-discord)).

## [2.1.1] - 2026-09-28

A security fix for the shell risk rules. Upgrade if you run 2.1.0: some
reworded destructive commands ran without asking.

### Security

- **Reworded destructive shell commands no longer slip past the risk
  rules** (#698). The rules scored how a command was spelled, not what it
  did. In 2.1.0 these ran with risk 0 while `rm -rf` asked:
  - `rm -r -f`, `rm --recursive --force`, `rm -r`;
  - `find -delete` / `-exec rm` / `xargs rm`;
  - `python -c "shutil.rmtree(…)"`, `node -e "fs.rmSync(…)"` and other
    interpreter one-liners that delete files;
  - `git push --force`, `reset --hard`, `clean -f`, `filter-branch`;
  - `echo … | base64 -d | sh`.

  Every rule now also looks at each command a line runs: through `&&`,
  `;` and `|`; through wrappers (`sudo`, `env`, `nice`, `timeout`,
  `xargs`); inside `bash -c "…"`, `eval` and `find -exec`; and at the
  commands an interpreter one-liner could shell out to. All of these
  reach at least the "medium" bucket, so they ask under the default
  policy. A destructive git command no longer gets the "benign git"
  discount. Benign lines (`rm file`, `find -name`, `git push origin main`,
  quoted text) score as before
  ([docs/detection.md](docs/detection.md#4-shell-danger-library-c3-226)).

## [2.1.0] - 2026-09-28

Integrations, a local daemon that makes the Claude Code hook fast, a model
picker in the TUI, and fixes from end-to-end QA. There are no breaking
changes. While `foreman start` runs, agents and the hook use its daemon
(`FOREMAN_NO_DAEMON=1` keeps the old in-process path); without it
everything works as before.

### Added
- **One daemon for every agent** ([docs/mcp-hub.md](docs/mcp-hub.md#one-daemon-for-every-agent)).
  While `foreman start` runs, agents' `foreman mcp-stdio` and Claude
  Code's PreToolUse hook connect to its daemon instead of starting Foreman
  themselves. `foreman daemon` runs it without the TUI.
  - `foreman doctor` has a `daemon` row: listening, not running, or why
    agents can't use it (socket path too long, a socket or token file they
    don't trust).
  - Each MCP hub stdio server starts once for all agents; each agent still
    sees only the servers its access list and `org.yaml` allow.
  - The hook answers in about 30 ms instead of about 200 ms (p50 on an
    Apple-silicon Mac; `node scripts/hook-latency.mjs`).
  - Same decisions as before, with the same code. The socket is a 0600
    Unix socket in the state directory (never TCP) with a per-boot token
    in a 0600 file. Agents still prove who they are with their own
    identity token, checked by the daemon.
  - Fail closed: if the daemon stops during a call, the hook blocks it
    (exit 2) and an MCP call gets an error; neither is retried. Without a
    daemon, or with a socket or token file that isn't safe to trust,
    everything runs in the agent's own process as before
    (`FOREMAN_NO_DAEMON=1` forces that). Native Windows keeps the
    in-process path.
- **Integrations** (`foreman integrations`,
  [docs/integrations.md](docs/integrations.md)): GitHub, GitLab, Jira and
  Confluence, Trello, Linear and Notion as managed MCP hub servers.
  - `add` reads the token from a hidden prompt (or `--token-stdin`) or runs
    the browser sign-in, saves the integration disabled, reviews and pins
    its tools, then enables it for the agents you chose (`--agents`,
    `--departments` or `--all-agents`).
  - Read-only by default: write tools are denied until `--read-write`;
    merges and pushes need a person on every call.
  - `list`, `show` (access per agent), `update` (access level, audience,
    products, params, variant, `--tool TOOL=RULE`, `--rotate`), `enable` /
    `disable` (reaches running agents at once), `login` / `logout`,
    `review`, `test`, `remove` (credentials nothing else uses go too) and
    `adopt` for servers added with `foreman mcp add`.
  - A second account is its own server with its own secret
    (`--name github-work` → `github-pat-work`).
  - The TUI has an Integrations page (`i`): add with a token or browser
    sign-in, review, enable / disable, edit the access level and who may
    use it, per-tool rules (`t`, `←→`), remove (asks first).
  - From chat: `/foreman integrations`, `/foreman integration status |
    enable | disable | remove <name>` in Slack and Discord, and
    `/integrations` / `/integration …` to the Telegram approval bot from your
    private chat. Removing asks for a one-time code; changes need an owner
    (`owner_user_ids` for Slack / Discord), land in the inbox, and a
    relaying agent can only read. Credentials never go through chat.
  - The setup wizard has an optional Integrations step (step 5 of 6, after
    Services): pick integrations, the access level (read-only by default)
    and a token for token variants. They're saved disabled for the agents
    picked in the wizard; the Done screen lists `foreman integrations
    review` / `login` for each. GitHub, Atlassian and Notion are no longer
    offered on the wizard's Services step (`services.json` keeps them).
    An existing setup is not reopened for the new step.
  - `foreman doctor` reports enabled integrations that can't work;
    `foreman secrets remove` / `rotate` say when an integration uses the
    secret.

- **MCP hub access lists, confirm rules and live reload**
  ([docs/mcp-hub.md](docs/mcp-hub.md#mcpyaml)).
  - `access: { agents: [...], departments: [...] }` on a server limits it
    to those agents and department members, on top of `org.yaml`
    (`access: {}` = nobody).
  - `tools.confirm` (merges, pushes): a person answers every call; no
    allow rule, "always allow" or low risk score approves it.
  - A running `foreman mcp-stdio` follows `mcp.yaml` and `org.yaml`: it
    sends `notifications/tools/list_changed`, and a call approved after its
    server was disabled or the agent lost access never runs (audited as
    denied). A broken file leaves no hub servers.
  - `foreman mcp add <id> --param host=…` for catalog servers with a
    configurable host (self-managed GitLab). `mcp.yaml` writes are locked
    and atomic and keep your comments.
- **Model picker in the TUI.** `m` on Settings picks Foreman's own model;
  `m` on Agents picks the selected agent's model (or puts it back on the
  default). The list shows the provider's fast / balanced / most capable
  models first, then its live list when a key is stored. A pick runs the
  same `model` command as the console.
- **Integration credentials stay with the hub.** A secret an integration
  server references can't be read by any agent through `secrets/get`,
  whatever `policy.yaml` says, and is never projected into agent files.

### Fixed
- **Approvals whose caller is gone no longer wait to be decided** (#691).
  When Foreman or an agent was killed while a call waited for approval,
  the approval stayed pending for up to 10 minutes: the next TUI session
  offered it, and allowing it recorded a decision for a call that could no
  longer run. The waiting caller now refreshes a heartbeat, and an approval
  whose caller stopped is cancelled (denied) within about 30 seconds. On a
  clean quit, a Claude Code hook call waiting on the daemon is told
  "Foreman is shutting down — blocking the call" instead of "the daemon
  went away".
- **Setup wizard wording, from terminal QA.**
  - The Providers summary asked "Continue to agents?" and the Services
    summary "Continue to install?". They now name the actual next step
    (Foreman's brain, Integrations).
  - The brain picker said Ollama and OpenAI-compatible brains were "coming
    in v0.2". They now say "not supported yet"; `foreman doctor` no longer
    names a version either.
  - Without a network, the brain's model list said only "fetch failed". It
    now says it couldn't reach the provider, as the agent step does.
  - The Done summary counted a stored GitHub token as "1 service github".
    Integrations are listed in their own block, not as services.
  - The Done screen no longer says "No Foreman identity file for
    claude-code (nothing to push)": nothing to push needs no line.
  - The TUI model picker says it couldn't reach the provider for its full
    model list, instead of "live list unavailable (fetch failed)".
  - The Done screen suggests `foreman agent hook install claude-code`
    while Claude Code's PreToolUse hook (checks its Bash, Edit and Read
    calls before they run) isn't installed; it is a separate opt-in.
- **`?` opens help on every page.** Every status bar says `? help`, but
  only Home opened it; on Agents, Settings, Logs, Policy, Sessions,
  Delegations, Inbox and the other pages the key did nothing. It now works
  everywhere except while a page takes typed text, and on the approval
  modal (help decides nothing; Esc goes back to the call).
- **A busy database no longer kills `foreman mcp-stdio` or `foreman start`**
  (#594). When another process held the SQLite lock past the 5 s busy
  timeout, the audit log's background write threw and the process exited
  mid-session: the agent's MCP server went unreachable and the batch it was
  writing, including the row of a call already allowed, was lost. The batch
  is now kept, in order, and retried with a bounded backoff, each failure
  reported on stderr. A failed control-channel drain in `foreman start` is
  reported and retried on the next tick, and a command whose status could
  not be written is not run a second time. Loading `policy.yaml` at start
  waits for another writer instead of failing with "policy.yaml failed to
  parse: database is locked".
- **`foreman agent remove` takes Foreman out of the agent's config.** It
  revoked the agent's token but left the `foreman` MCP server entry (e.g.
  `mcpServers.foreman` in `~/.claude.json`, `mcp_servers.foreman` for Codex
  and Hermes, ZeroClaw's `[[mcp.servers]]` entry and `foreman` bundle) and
  Claude Code's PreToolUse hook behind. Removing an agent from the CLI, the
  TUI (`x`) or by unticking it in the setup wizard now removes that agent's
  own entries, keeps every other server, hook and key and the file's
  permissions, and prints what it removed. A config it can't read, parse or
  that is a symlink is left alone with a note and never blocks the removal
  ([docs/agent-lifecycle.md](docs/agent-lifecycle.md#what-gets-cleaned-up-on-remove)).
- **Current default models.** Gemini's default, `gemini-2.0-flash`, has
  been shut down by Google, so a Gemini brain stopped working; OpenAI's was
  the older `gpt-4o-mini`. The defaults now come from one place,
  `registry/providers.json` (`default_model` plus `model_tiers`: fast,
  balanced, strongest): `claude-haiku-4-5`, `gpt-6-luna` and
  `gemini-3.5-flash-lite`, also for Hermes, OpenClaw and the OpenRouter
  preset. `/foreman model`'s tap-to-copy list follows the tiers and covers
  Gemini. The wizard's live model list now includes GPT-6 models and sorts
  newest first by version (Claude Fable no longer sank below Haiku).
- **`can_call_agents_with_responsibility` is checked.** The starter
  `policy.yaml` uses it, but it was accepted and ignored. A hand-off to an
  agent whose responsibility note is known and isn't on the list now adds
  40 risk points (like the other responsibility rules, it never denies on
  its own; an agent without a note adds nothing).
- **`foreman org check` explains more and fails on a typo.** It names the
  side (`<from>` / `<to>`) that isn't in `org.yaml` and exits 1, accepts a
  role id as well as an agent id, and keeps the chart's own reason for a
  block with the route it allows instead (`next: hand it to cto
  (claude-code), engineer's manager, …`). It checks `policy.yaml` first and
  says when a `cannot_call` rule, a `can_call` list or an `ask` rule
  decides. Hand-off enforcement is unchanged; the docs now say that a
  `can_call` allow doesn't lift a block from the org chart.
- **`foreman agent show` shows the agent's public key.** Text output adds a
  `key:` line with the `ed25519:xxxxxxxx…` fingerprint (the style
  `foreman init` uses for Foreman's own key); `--json` adds `publicKey`
  (hex) and `publicKeyFingerprint`. No private material is printed.
- **`foreman doctor` before `init`.** The `fts5` row said `requests_fts ready`
  before any database existed. It now reports ``FTS5 available (no database
  yet — run `foreman init`)`` until `foreman.db` exists, and only says
  `requests_fts ready` when the real database has the table.
- **LLM budget pricing.** A model missing from Foreman's price table was
  billed at the provider's cheapest rate: Claude Opus 5 or Fable at Haiku
  prices, gpt-5.x at gpt-4o-mini, Gemini 2.5 and 3.x at 2.0 Flash, so the
  hard budget cap tripped 5 to 60 times too late. The tables now carry the
  current models' list prices, and an unknown model is billed at the
  provider's most expensive current rate, so a budget never runs over.
  Claude Opus 4.5 to 4.8 are billed at $5 / $25, not $15 / $75.

- **Ctrl-C quits with exit code 130** in `foreman setup` and at `foreman
  start`'s first-run prompt, like any interrupted command, so scripts can
  tell an aborted setup from a finished one. The prompt used to exit 13.
- **`foreman secrets list` hides agent identity tokens**, as the TUI Keys
  page already did, and `foreman secrets remove` refuses them. Removing one
  silently cut an agent off; `foreman agent token rotate` and `foreman
  agent remove` are the ways to change them.
- **An allowed call's security report no longer says policy asked for
  approval.** `foreman log show` said "policy asked for explicit approval"
  for every call without risk factors. It now says so only when
  `policy.yaml` (or a confirm rule) asked.
- **The help overlay explains the `y` confirmation** that allowing a high-
  or critical-risk call takes.

## [2.0.0] - 2026-09-28

The first release since 0.1.6. The version jumps to 2.0.0 because several
interfaces and defaults changed in ways that can break an existing setup.
Read **Breaking changes** before you upgrade.

### Breaking changes

- **Node 22.12+** is required (see Changed).
- **Agent identity tokens (#618).** Agents wired before this release run as
  `untrusted:<id>` until you run `foreman agent rewire --all` and restart
  them. See the upgrade note under Changed.
- **Webhook signatures (#656).** `X-Foreman-Signature` is now an HMAC-SHA256
  over `<X-Foreman-Timestamp>.<raw body>`, not over the body alone, and
  every POST carries `X-Foreman-Timestamp` (Unix seconds). Receivers that
  verify the old signature reject every delivery until they are updated
  ([docs/notifications.md](docs/notifications.md)).
- **Push URLs (#656).** Slack and Discord webhook URLs and the ntfy server
  must be `https://` (plain `http://` only to this machine), and a URL with
  a user name or password is refused.
- **`foreman agent remove` keeps the agent's program (#657).** It
  unregisters the agent and revokes its key and identity token, but no
  longer uninstalls the binary. `--uninstall` does, and only for agents
  Foreman installed itself.
- **`foreman report` prints a table (#657).** Use `--json` for the digest
  scripts used to read.
- **Relayed `/foreman` commands (#656).** A command an agent relays (for
  example from Telegram) that changes Foreman, such as `stop` or
  `model <x>`, now waits for your approval. Read-only verbs still run at
  once.
- **A broken `policy.yaml` stops `foreman start`** and `foreman wrap` with
  the file, line and reason, instead of a stack trace (#657). A second
  `foreman start` on the same home refuses to run.

### Added

- **Per-agent identity tokens on the MCP path** (#618,
  [docs](docs/agent-lifecycle.md#agent-identity-tokens)).
  - `foreman agent add` mints a token, keeps it in the encrypted secret
    store and writes it into the agent's MCP config as
    `FOREMAN_AGENT_TOKEN` in the server's `env`, never as an argument
    (`FOREMAN_AGENT_TOKEN_FILE`, a 0600 file, works too). Files that carry
    it are owner-only, never written through a symlink or inside a
    project's git work tree; the setup wizard leaves such a config alone
    (no template seed, no projected keys) and says why.
  - `foreman mcp-stdio` resolves the agent from the token. `--source`
    without a valid token runs as `untrusted:<id>`: none of that agent's
    allow rules, org role, delegation rights, secrets or MCP hub servers,
    and no relaying for you (answers, resolutions, state-changing
    `/foreman` commands, untagged approvals), while the agent's deny / ask
    rules, responsibility rules, rate limits, block and pause still apply.
    All untrusted connections share 30 calls a minute and 3 waiting
    approval prompts.
  - `identity.untrusted` in `policy.yaml`: `ask` (default, nothing is
    auto-allowed), `deny` (quarantine) or `allow_wildcards`.
  - `foreman agent rewire [<id>|--all]` gives existing agents a token and
    rewrites their wiring; `foreman agent token rotate <id>` replaces a
    token, always revoking the old one first, and cuts off sessions using
    it. `--token-out <file>` (0600) covers agents wired by hand; the setup
    wizard names that command for agents it has no config to wire
    (generic-mcp), in its install log and on the Done screen.
  - `foreman doctor` (`agent_tokens`) and `foreman start` (an inbox warning)
    name the agents that still need rewiring and token files others can
    read. Doctor counts only agents whose wiring it read and verified; one
    whose wiring it can't see (generic-mcp) gets its own
    `agent_tokens:<id>` warning. Unverified connections are audited (`agent:identity`) and raised
    in the inbox once a day; tokens never are. Tamper protection flags an
    agent reading another agent's wiring or any `/proc/*/environ`.
  - The Claude Code hook skips `mcp__foreman__*` tools only when each
    `foreman` server entry starts the same Foreman install the hook runs
    from (bare `foreman` on PATH, or an absolute path with the same real
    path) with nothing but the agent token in `env`. A look-alike with
    another binary, `FOREMAN_HOME`, `NODE_OPTIONS` or extra keys is gated.
- **OAuth for hosted MCP servers** (#617,
  [docs/mcp-hub.md](docs/mcp-hub.md#oauth-servers)).
  - Mark a remote server `auth: oauth` in `mcp.yaml` (or use
    `foreman mcp add <name> --url <url> --oauth`), then run
    `foreman mcp login <name>`. Foreman discovers the authorization server,
    registers itself as a client, and signs you in in the browser (PKCE
    S256, a one-shot `127.0.0.1` redirect listener with a `state` check).
    `foreman mcp logout <name>` deletes the tokens and revokes them at the
    provider when the server supports it.
  - The hub attaches the bearer token upstream. It refreshes the token
    before it expires and once on a 401, and it saves rotated refresh
    tokens in one write, even when several agents share the session.
    Refreshes, login, logout and `mcp remove` share one lock, so a logout
    is never undone by a refresh already in progress.
  - `foreman mcp list` and `foreman doctor` show whether each server is
    logged in, when its token expires, or that it needs login.
  - Tokens live only in the encrypted secret store. They never appear in
    `mcp.yaml`, CLI output, errors, tool results or the audit log.
    Agents can't read them: `secrets/get` refuses `mcp-oauth-*` names
    whatever the policy says.

- **End-to-end QA suite** (#624, [docs/qa.md](docs/qa.md)).
  - `npm run qa` walks eight user journeys, the Claude Code
    PreToolUse hook among them, with real processes in
    isolated homes, and checks the audit trail each time.
  - CI runs it on Linux and keeps the Markdown report as an artifact.
- **`foreman demo`** (#632). A company of agents works through a day in a
  sandbox while you watch the real TUI: approvals, a blocked poisoned
  instruction, department messages, a budget alert and a report to you.
  - The agents are stand-ins, and they are the only agent CLIs on the
    demo's `PATH`.
  - The demo runs in its own throwaway `FOREMAN_HOME`. No keys are needed,
    and nothing outside a temp folder is touched.
- **TUI as a control surface** ([docs/tui.md](docs/tui.md))
  - A new look: a status header (agents online, approvals waiting,
    unread notifications, today's counts), a tab row for every page, and
    key hints for the page you're on. Panels use rounded frames, and the
    boot banner is a splash that any key dismisses.
  - Approval queue (#614). Every pending approval is kept, oldest deadline
    first; `←`/`→` move between them, and each key decides the one on
    screen.
  - Command console (#612). Press `:` for the same verbs as `/foreman` in
    chat (`status`, `write`, `assign`, `org`, `report`, `llm`, …) plus
    `approve`/`deny`, `open <page>` and `inbox read`. It has history and tab
    completion, and every command is audited.
  - Inbox (#613). Approvals, blocked calls, crashed or missing agents, task
    results, budget alerts and updates are kept with read state. The TUI
    shows an unread badge and toasts; `foreman inbox` works from any shell.
- **Telegram approval bot** (#610, `foreman notify approval-bot`).
  - Approvals go through a second bot that only Foreman holds and polls, so
    no agent ever sees an approval button.
  - Taps are accepted only from your chat and only with the button's HMAC
    tag, and the buttons are removed after the first tap.
  - `foreman doctor` suggests it when Telegram approvals are relayed.
- **Two-way Slack and Discord** (#615, `foreman notify slack-interactive`,
  `foreman notify discord-interactive`).
  - Approval messages get Allow / Deny buttons, and `/foreman` runs the same
    commands as the TUI console.
  - Foreman holds the connection itself (Slack Socket Mode, the Discord
    Gateway, on Node's built-in WebSocket), so no public URL and no new
    dependency are needed.
  - Only the listed user ids can act. Buttons carry HMAC tags, stale buttons
    say so instead of deciding anything, and reconnects back off.
- **Org spend and reports** (#629).
  - `foreman org report marketing month` and `/foreman report marketing month`
    show what a department, role or agent did and what it cost, with no LLM.
  - `foreman usage` shows spend by department, agent or model.
  - Numbers come from OpenTelemetry sent by the agents: `foreman start`
    listens on 127.0.0.1 and keeps counts only. Tasks Foreman starts report
    automatically, and `foreman usage env <agent>` covers the rest. Usage
    printed by an agent CLI is the fallback.
  - Department budgets (`foreman org budget marketing 50 --pause`) alert at
    80% and 100%. With `--pause`, agents can't delegate into a department
    that has spent its budget.
- **Department channels** (#630). Agents talk to each other through
  Foreman, in department rooms, leadership, all-hands and role-to-role
  threads, following the org chart.
  - Agents use the MCP tools `org_post`, `org_read` and `org_report`.
  - You read everything (`foreman org messages`, `comms`) and post as
    yourself (`foreman org tell`, `tell`).
  - `foreman org channel marketing slack "#marketing"` mirrors a channel to
    Slack or Discord with Foreman's bot. Agents never hold the tokens.
- **Approval escalation along reporting lines** (#623,
  [docs/org.md](docs/org.md#approval-escalation)).
  - `approvals.escalate_via_manager: true` in `org.yaml` (or
    `foreman org escalate on`) sends low- and medium-risk approvals to the
    requester's manager agent as a review request on their thread.
  - The review request carries an opaque review id, never the approval id.
    The manager answers with the `org_recommend` MCP tool. You see the
    recommendation, labelled "unverified id", on the TUI approval screen,
    in the inbox and in the chat where the approval waits.
  - It is advice only. It never approves, denies, extends or shortens an
    approval, and it doesn't change the timeout default. Only the
    requester's actual manager can recommend: not a colleague, not the
    requester, not a human source, not a blocked or disabled agent.
  - Arguments sent for review have sensitive keys and inline credentials
    masked. Review requests are never mirrored to Slack or Discord.
  - High and critical approvals always go straight to you. At most one
    review request per report and manager every 30 seconds. Recommendations
    are audited as `org:recommendation`.
- **Grow the org from the CLI:** `foreman org add-department` and
  `foreman org add-role`. Both validate the chart and keep your comments.
- `assign` and `org` chat verbs: route a task through `org.yaml` from
  Telegram or the TUI.
- `NO_COLOR` is honoured by the TUI.
- **MCP Hub** (`foreman mcp …`): connect upstream MCP servers once and every
  agent gets them, with each call mediated (policy, risk, approval, audit).
  - Includes a curated catalog of 19 verified servers.
  - Secrets are referenced as `${secret:…}` and stay out of agent configs.
  - Tool-poisoning scanner, and rug-pull detection that pins tool definitions.
  - Result guard: redacts secrets and flags injected instructions.
  - Lazy tool discovery and result budgets to save tokens.
- **Foreman Org** (`foreman org …`): departments, roles and reporting lines
  for your agents.
  - Starter templates: startup, software-team, solo.
  - Delegation is enforced along the chart.
  - MCP access is scoped per department.
  - `org sync` pushes roles to agents; `org upgrade` updates their runtimes.
- **Notification channels**: Slack, Discord, email (dependency-free SMTP) and
  ntfy phone push.
  - `foreman notify ntfy-setup` and `foreman notify route` commands.
  - All channels are built by one factory, used by both `foreman start` and
    `foreman notify test`.
- **Tamper-protection risk rule**: flags agents touching Foreman's database,
  keys and policy, their own hook or MCP wiring, or mutating `foreman` CLI
  commands.
- `foreman-hook` binary: a lightweight PreToolUse entry that starts about a
  third faster on every Claude Code tool call.
- New `foreman doctor` checks: `notify_channels`, `mcp_hub`, `org`.
- CI:
  - Always-on `verify` gate for every PR (#589).
  - CodeQL scanning.
  - Node 22/24 test matrix.

### Fixed

- **Security fixes from the end-user QA pass** (#656).
  - Agents can't run Foreman: relayed commands that change it need you
    (see Breaking changes), and a `--source` can't create, revive or
    re-spell an agent.
  - Policy edits apply live, without a restart, and rule ids stay stable,
    so audit rows keep pointing at the right rule. A block rule lives in
    `policy.yaml` only and goes away when you remove it.
  - Agent-to-agent rules work: `can_call` / `cannot_call`,
    `<agent>:<tool>` rules and the delegation fields of responsibility
    policies bind hand-offs (`write`, `assign`).
  - The `.env` and SSH-key guards hold whatever a transport calls the tool
    (Hermes, OpenClaw and ZeroClaw report reads as `read`). Deny and ask
    rules cover every alias; allow rules never widen.
  - `rate_limits.tokens_per_hour` is enforced.
  - "Always allow / deny" remembers the call you answered (same agent,
    tool and file or command), not the whole tool, and says so first.
  - Allowing a high- or critical-risk call in the TUI takes a second key
    (`a`, then `y`). Hidden terminal characters in agent text are shown as
    visible symbols, so they can't hide a path on the approval screen.
  - Only your own denials count as "previously denied".
  - Stripe, npm, Notion and Discord tokens are redacted. Secret names are
    validated, `--value` warns about shell history, and
    `secrets show --reveal` is audited.
  - The Claude Code hook honours `FOREMAN_APPROVAL_TIMEOUT`; `mcp-stdio`
    answers `ping` and non-JSON input as JSON-RPC says.
- **CLI and TUI fixes from the end-user QA pass** (#657).
  - `foreman usage env <agent>` gives each agent a usage key of its own,
    so an agent can no longer book its spend to another one.
  - Log search text is never parsed as FTS5 syntax (it used to crash).
  - The TUI asks before deleting a secret or removing an agent, and the
    Keys page never lists or deletes agent identity tokens.
  - `foreman agent add <registry-id>` works without `--type`.
  - `foreman doctor` never creates `secrets.key`, fails loudly when it
    can't decrypt the secrets, checks the policy schema and rule regexes,
    and gives a fresh box no false warnings. `migrate-config` never moves
    the live home.
  - `foreman notify enable` points the channel at its credentials, and
    offline errors say "couldn't reach", not "rejected".
  - The setup wizard and the help overlay fit an 80x24 terminal; `q` and
    Ctrl-C quit the same way on every screen; the wizard warns about a
    token, chat id or endpoint with the wrong shape.
  - Approvals that timed out while `foreman start` wasn't running leave a
    trace in the inbox. `log tail` shows what each call was about, and
    `org messages boss` is your inbox.
- **OpenClaw on an older Node** (#646). OpenClaw needs Node
  `>=24.16.0 <25 || >=26.1.0` since v2026.9.3; Foreman runs on 22.12+.
  When the `node` on PATH is outside that range, the setup wizard,
  `foreman agent add` and `foreman agent update` no longer run
  `npm install -g openclaw`. They print the requirement and OpenClaw's
  upstream installer command for you to run yourself, and the wizard goes
  on with the other agents. `foreman doctor` warns while a registered or
  installed OpenClaw can't run. The range lives in the registry as
  `engines.node`.
- **Agent MCP wiring lands where each agent reads it** (#591, #618):
  - **Claude Code:** the `foreman` MCP server goes into `~/.claude.json`
    (top-level `mcpServers`), where Claude Code reads user-scope servers.
    `~/.claude/settings.json` has no `mcpServers` key; it keeps only the env
    projection and the PreToolUse hook. Config writes keep every other key,
    are owner-only and replace the file in one step. Run
    `foreman agent rewire claude-code` to move an existing install.
  - **Hermes:** the entry goes into the top-level `mcp_servers:` map of
    `~/.hermes/config.yaml`, which is what Hermes reads. Foreman writes it
    directly (command, args and the token env), so the wizard no longer
    runs `hermes mcp add` with a wrapper script, and a stale
    `mcpServers.foreman` from older Foreman versions is removed.
  - **ZeroClaw:** `config.toml` gets a `[[mcp.servers]]` entry named
    `foreman` and a `[mcp_bundles.foreman]` bundle granted to every
    `[agents.<alias>]` (ZeroClaw connects an agent only to its bundles'
    servers). The ignored `[mcpServers.foreman]` table is removed. When the
    file declares no agent alias, `foreman agent add` / `rewire` say how to
    grant the bundle.
  - **Codex:** Foreman no longer writes `preferred_auth_method` into
    `~/.codex/config.toml`; that key is gone from Codex's config schema.
    Nothing replaces it. API keys still go to `~/.codex/auth.json`, and
    ChatGPT sign-in is `codex login`.
- **Opening a browser on Windows** no longer goes through `cmd /c start`.
  A URL with `&` or `|` in it could be cut short there or run a command.
  Foreman now uses `rundll32 url.dll,FileProtocolHandler` with no shell.
  This covers the setup wizard, `foreman llm login` and
  `foreman mcp login`.
- **Standalone binaries** ([docs/install.md](docs/install.md#standalone-binary-no-nodejs), [docs/releasing.md](docs/releasing.md#standalone-binaries)).
  - The pkg build failed on all four targets, and the binary it made could not have run: the MCP SDK's subpath imports were missing, Ink's and yoga-layout's top-level `await` broke, and its small-ICU Node crashes Ink on any non-ASCII text.
  - Each binary is now a Node.js single executable application on the official Node.js 22 build, with the whole CLI bundled in. It's about 130 MB.
  - Every binary is smoke-tested on its own platform: `init`, `doctor`, `mcp-stdio`, the MCP hub, the TUI and `foreman demo`.
- **Claude Code hook:** `mcp__foreman__*` tools skip the hook only when they are tools Foreman actually serves, and no project `.mcp.json` or local-scope config swaps in another `foreman` server. Anything else is gated (#619).
- **MCP hub:** a call withheld as a possible rug pull is logged as denied (`mcp:withheld:<server>`), not as the policy's allow (#635). `foreman mcp tools <server>` shows the rug pull even without `--refresh` (#634).
- **Webhook:**
  - the outcome message carries the approval's `id` and `requestId`, and is sent once instead of on every countdown refresh;
  - the URL must be `https://` (plain `http://` only to this machine) (#636).
- **TUI:** `q` on the approval screen asks to quit; it never decides the approval. Decisions made in the TUI, or in chat, are recorded as `user:tui`, `user:telegram` and so on across processes (migration `0026`) (#637).
- **Security**
  - The Claude Code hook now fails closed. Before, any error (a locked DB, bad
    JSON) let the tool run.
  - The hook now applies `policy.yaml` and writes audit rows.
  - Telegram approvals work end to end. Buttons carry the real approval id plus
    an HMAC tag, and decisions are persisted across processes.
    - A relayed allow, or any policy change, needs the tag.
    - Other agents can no longer approve pending calls by id.
    - Allow tokens are kept out of the message text.
    - See SECURITY.md for the remaining limit with the chat agent itself.
  - LLM verdicts can only make Foreman stricter; a prompt-injected "allow" can
    no longer relax a gate.
  - Secrets are redacted from notifications, the verifier prompt, the security
    report and the audit log.
  - Config and state directories are 0700; the DB and policy files are 0600.
  - Blocked or paused agents are denied on every transport.
  - Policy matching:
    - Invalid regexes fail safe (including `toolPattern`).
    - Paths are normalised and matched case-insensitively across all
      path-like arguments.
    - Restrictive rules apply when any path or command field matches. An
      allow rule applies only when every one does, so `..` and a second
      argument can't ride on an allowed path.
    - Precedence: a rule overrides another only when it is more specific
      on one axis (exact source, conditions) and no less specific on the
      other. Otherwise the stricter one wins. A remembered "always allow"
      still beats a blanket ask, but no longer overrides targeted guards,
      and a wildcard allow can no longer lift a per-agent ask.
  - The default policy also guards `file_write` (Claude Code / Codex writes),
    not only `write_file`. Existing `policy.yaml` files are unchanged; re-run
    `foreman init --reset-policy` or copy the rule to pick it up.
  - The Claude Code hook fails closed through the main `foreman hook` CLI
    too (escaped errors and usage errors exit 2), and it now gates `Grep`
    and `Glob`.
  - The tool scanner detects Unicode tag characters and scans tool names and
    annotations. Pins cover annotations.
  - Upstream MCP start-up errors no longer echo injected secrets to the agent
    or the audit log.
  - Private-key redaction is linear-time and masks keys whose END line was
    cut off.
  - A webhook whose signing secret is missing stays off instead of sending
    unsigned.
  - Fixed a ReDoS in the database-URL secret pattern.
  - SSH key globs and suffixed key names are now detected.
  - A one-time ACP allow can no longer turn into a permanent `allow_always`.
  - A child process printing non-object JSON no longer crashes `foreman start`.
  - Oversized MCP frames are dropped.
  - The secret-projection temp file is no longer predictable.
  - Removed `env` from the curated allowlists.
- **mcp-stdio** (#594)
  - Concurrent message handling.
  - JSON-RPC errors instead of crashing the process.
  - Pending approvals are cancelled and audited when the client disconnects.
- **Notifications**: Slack and Discord were enabled by the wizard but never
  built at runtime.
- **TUI**
  - The TUI no longer denies every approval after 60 seconds on its own
    clock. Previously this also cut 10-minute Telegram approvals short.
  - A second approval no longer replaces the first on screen.
  - Approvals decided elsewhere (a Telegram tap, a timeout in the requesting
    process) now leave the screen.
- `foreman start` no longer crashes when a registered agent's daemon
  binary isn't installed; the inbox says which one and how to fix it.
- **Approvals**
  - Timeouts are audited as `approval-timeout`, and approvals cancelled by a
    disconnect as `approval-cancelled`.
  - Relayed `block_*` taps now inject their rule (the injector was never
    wired). Long rule names use a compact id instead of dropping the button.
- **Misc**
  - Agent-side session ids no longer abort approved calls.
  - The delegation watchdog is cleared on shutdown.
  - The CLI uses `parseAsync`.
  - Pushing a SOUL backs up user-authored identity files.

### Changed

- **Release pipeline** (#620, [docs/releasing.md](docs/releasing.md)).
  - Publishing a GitHub release now publishes to npm with provenance.
  - Each binary is built and smoke-tested on its own architecture (macOS arm64 and x64, Linux x64 and arm64) and ships with `SHA256SUMS`.
  - Every workflow pins its actions by commit SHA.
- Node **22.12+** is required. Node 20 reached end-of-life on 2026-04-30, and
  `ink` 7 / `commander` 15 need Node 22. The installer now sets up Node 22.
- The default Claude Code hook matcher also covers `Read`, `NotebookEdit`,
  `WebSearch` and third-party `mcp__…` tools.
- The MCP SDK floor is raised to 1.30 (lockfile unchanged).
- **better-sqlite3 13** (#644, [supported platforms](docs/install.md#supported-platforms)).
  - The SQLite driver moves from 12.11 to 13.0.3: N-API, SQLite 3.53.4,
    and prebuilt binaries inside the npm package instead of an install-time
    download from GitHub (`prebuild-install` and `bindings` are gone, and
    there is no install script). The binaries are covered by the lockfile's
    integrity hash; the package grows from 2.7 MB to 11.4 MB (27 MB
    unpacked).
  - Supported platforms are macOS, Linux (glibc and musl) and Windows on
    x64 and arm64; Foreman itself runs on Windows through WSL2. Other
    platforms no longer build the driver from source and can't open the
    database.
  - The standalone binaries embed the prebuilt addon for their target
    and load it from the hash-checked runtime directory as before.
- **Upgrade note (#618):** agents wired before identity tokens keep
  working, but as `untrusted:<id>` (lowest privilege) until you run
  `foreman agent rewire --all` and restart them. `mcp-stdio` no longer
  registers unknown `--source` ids on first connection; register agents with
  `foreman agent add`. `foreman secrets show` / `add` / `rotate` refuse the
  reserved `foreman-agent-token:*` names. `--source` must match
  `[A-Za-z0-9._-]{1,64}`. Until rewired, untrusted agents' calls ask for
  approval by default (`identity.untrusted: ask`).

## [0.1.6] - 2026-06-01

See the [GitHub releases](https://github.com/tuzlu07x/foreman/releases) for
the notes of 0.1.6 and earlier.
