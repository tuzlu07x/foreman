# Out-of-band notifications (#235 — C11)

How Foreman reaches you when you're not at the terminal. Channels:
**Telegram** (alerts + tap-to-approve), **Slack**, **Discord**, **email**
(SMTP), **ntfy** (phone push, no account), a signed **webhook**, and native
**system** notifications. Approvals are decided in the TUI or in Telegram;
the push-only channels tell you where to decide and never carry the
approval token.

Fastest way to get alerts on your phone:

```bash
foreman notify ntfy-setup      # creates a private topic, enables + routes it
foreman notify test ntfy
```

---

## 1. The pitch

Other agent platforms run agents. Foreman watches them, scores their actions, and **reaches out to you wherever you are when something looks wrong**. Telegram in your pocket, Slack at your desk, Discord wherever — Foreman pauses the agent until you decide.

Phishing attempt at 3 AM? Foreman knows AND can tell you. You tap *Deny* on your phone. Agent gets the denial. You go back to sleep.

---

## 2. `~/.foreman/notify.yaml` config

```yaml
channels:
  telegram:
    enabled: true
    bot_token_ref: telegram-bot-token   # key in Foreman's secret store
    chat_id: "123456789"                # your numeric Telegram chat id

  webhook:                              # outbound-only — see §3b
    enabled: false
    webhook_url_ref: webhook-url        # secret ref for destination URL
    signing_secret_ref: webhook-secret  # optional — HMAC-SHA256 signing

  system:                               # macOS / Linux native notifications
    enabled: false

  slack:                                # incoming webhook (simplest) …
    enabled: false
    webhook_url_ref: slack-webhook-url
    # … or a bot token + channel (lets Foreman edit resolved alerts):
    # bot_token_ref: slack-bot-token
    # channel: C0123ABCD

  discord:                              # channel webhook or bot + channel id
    enabled: false
    webhook_url_ref: discord-webhook-url
    # bot_token_ref: discord-bot-token
    # channel: "123456789012345678"

  email:                                # any SMTP submission server
    enabled: false
    smtp_host: smtp.gmail.com
    smtp_port: 465                      # 465 → implicit TLS, 587 → STARTTLS
    smtp_username: you@gmail.com
    password_ref: smtp-app-password     # app password, stored encrypted
    email_from: you@gmail.com
    email_to: [you@gmail.com]

  ntfy:                                 # `foreman notify ntfy-setup` writes this
    enabled: false
    server: https://ntfy.sh
    topic_ref: ntfy-topic               # the topic name is the secret

routing:
  critical:                              # high/critical risk → must ask
    channels: [telegram]
    timeout_seconds: 300                 # 5 min until default_action fires
    default_action: deny                 # safer than allow

  warning:                               # heads-up only
    channels: [telegram]
    timeout_seconds: 0                   # purely informational

  info:                                  # routine activity — silent by default
    channels: []
    timeout_seconds: 0

  summary:                               # daily digest (C11c)
    channels: [telegram]
    schedule: "daily 20:00"

  budget_alert:                          # LLM spend warning (C10)
    channels: [telegram]
    timeout_seconds: 0
```

Defaults match this shape — every level has a sane out-of-the-box route. Run `foreman notify status` to see what's active.

---

## 3. Setting up Telegram

### Bot creation
1. Open Telegram, message [@BotFather](https://t.me/BotFather).
2. Send `/newbot`, follow the prompts, copy the bot token.
3. Store the token in Foreman's encrypted secret store:
   ```bash
   foreman secrets add telegram-bot-token
   # paste the token, hit Enter
   ```

### Chat id discovery
1. Open a chat with your new bot (search the bot username in Telegram).
2. Send any message ("hi").
3. Fetch the updates with the token to find your chat_id:
   ```bash
   curl -s "https://api.telegram.org/bot$(foreman secrets reveal telegram-bot-token)/getUpdates" \
     | jq '.result[-1].message.chat.id'
   ```
4. Edit `~/.foreman/notify.yaml` and set `channels.telegram.chat_id` to the number you saw.

The setup wizard will automate steps 1-4 when [#220](https://github.com/tuzlu07x/foreman/issues/220) lands.

### Enable + test
```bash
foreman notify enable telegram
foreman notify test telegram
# → check your Telegram chat — you should see a "Foreman test ✓" message
```

### Approval bot (recommended)

If an agent (Hermes, OpenClaw, …) also uses your Telegram bot, it reads every
update that bot receives, including your taps on approval buttons. Give
approvals a **second bot that only Foreman holds**:

1. Create another bot with [@BotFather](https://t.me/BotFather) (for example
   `acme_foreman_approvals_bot`).
2. Store its token and switch approvals over:
   ```bash
   foreman secrets add telegram-approval-bot-token
   foreman notify approval-bot          # checks the token with Telegram
   ```
3. Open a chat with the new bot and press **Start** (Telegram requires it
   once), then restart `foreman start`.

From then on, approval prompts arrive from the approval bot. `foreman start`
polls it itself, and a tap resolves the approval directly, audited as
`user:telegram`. Foreman accepts taps only from your chat, and only when
they carry the HMAC tag it put on that button. The buttons are removed
after the first tap. Alerts, digests and your agent's own questions stay on
the chat bot.

Never give the approval bot's token to an agent. If another process starts
polling it, the TUI inbox shows a warning. `foreman notify approval-bot --off`
goes back to relaying approvals through the chat bot.

---

## 3a. Two-way Slack and Discord (#615)

By default Slack and Discord are push-only: they alert you, and you decide in
the TUI or Telegram. Turn on two-way mode and you get **Allow / Deny buttons**
on approval messages and a **`/foreman` command** (`status`, `org`, `report`,
`write codex fix the flaky test`, …). No public URL is needed: Foreman opens
the connection itself (Slack Socket Mode, the Discord Gateway), with tokens
that only Foreman holds.

Only the user ids you list can press a button or run a command. Everyone
else gets a private "not allowed" reply. Each button carries an HMAC tag
bound to that approval and that action, so a payload Foreman didn't render
is refused. After a decision, the buttons are replaced with the outcome.
A button whose approval is no longer open (decided elsewhere, or re-sent after
a restart) says so instead of deciding anything.

### Slack (Socket Mode)

You need the Slack channel set up first (webhook or bot, see
[Channel setup](#channel-setup)).

1. Open your app at [api.slack.com/apps](https://api.slack.com/apps). Create
   one "from scratch" if you don't have one, and install it to your workspace.
2. **Socket Mode** → turn it on. Generate an **app-level token** with the
   `connections:write` scope (it starts with `xapp-`).
3. **Interactivity & Shortcuts** → turn it on. Socket Mode needs no request
   URL.
4. **Slash Commands** → create `/foreman` (any description).
5. Reinstall the app if Slack asks you to.
6. Store the token and turn two-way mode on for yourself. Your member id is
   under your Slack profile → ⋮ → *Copy member ID*.
   ```bash
   foreman secrets add slack-app-token          # paste the xapp-… token
   foreman notify slack-interactive --user U0123ABCD
   ```
7. Restart `foreman start`.

### Discord (Gateway)

Two-way Discord needs a **bot**; a channel webhook can't receive button
presses.

1. [discord.com/developers/applications](https://discord.com/developers/applications)
   → New Application → **Bot** → reset and copy the token. No privileged
   intents are needed.
2. **OAuth2 → URL Generator**: select the scopes `bot` and
   `applications.commands`, and the bot permissions *Send Messages* and
   *Embed Links*. Open the generated URL and add the bot to your server.
3. Point Foreman at the bot and the alerts channel. Turn on Developer Mode
   (User Settings → Advanced), then right-click the channel → *Copy Channel ID*
   and yourself → *Copy User ID*.
   ```yaml
   # notify.yaml
   channels:
     discord:
       enabled: true
       bot_token_ref: discord-bot-token
       channel: "123456789012345678"
   ```
   ```bash
   foreman secrets add discord-bot-token
   foreman notify discord-interactive --user 111111111111111111
   ```
4. Restart `foreman start`. It connects to the gateway and registers
   `/foreman`.

`foreman doctor` lists two-way channels (`two-way: slack (1 user(s))`). If a
token is rejected or the connection keeps failing, a warning lands in the TUI
inbox. Undo with `--off`.

---

## 3b. Webhook + System channels (C11b-1)

Two **outbound-only** channels for deployments that want delivery without bidirectional callbacks. They send alerts but can't capture user decisions — pair them with Telegram (or the TUI) for the actual deciding.

### Webhook — generic HTTP POST integration

Routes every notification as a JSON POST to your configured URL. Suitable for Discord/Slack-incoming webhooks, n8n / Zapier / PagerDuty, or your own relay.

The URL must be `https://`. Plain `http://` is only accepted to this machine (`localhost`, `127.0.0.1`, `::1`), because the payload describes tool calls.

```bash
foreman secrets add webhook-url
# paste the URL, hit Enter
foreman secrets add webhook-secret      # optional — HMAC signing key
foreman notify enable webhook
foreman notify test webhook
```

Then edit `~/.foreman/notify.yaml`:

```yaml
channels:
  webhook:
    enabled: true
    webhook_url_ref: webhook-url
    signing_secret_ref: webhook-secret   # optional
```

**Payload shape** (`schema: "foreman.notification.v1"`):

```json
{
  "schema": "foreman.notification.v1",
  "id": "01JZ...",
  "level": "critical",
  "requestId": "req-abc",
  "title": "[CRITICAL] hermes → claude-code · read_file",
  "body": "Risk score: 80/100 (high)\n\nSecret-related (+60 pts):\n  +60  .env-style file …",
  "actions": [
    { "id": "allow", "label": "Allow once", "style": "primary" },
    { "id": "deny", "label": "Deny", "style": "danger" }
  ],
  "agentBlocking": true,
  "sentAt": 1779800000000,
  "kind": "notification",
  "messageId": "webhook:1:01JZ...:req-abc"
}
```

When an approval is decided or times out, Foreman sends **one** more POST with the outcome. It has `"kind": "outcome"`, the same `id` and `requestId` as the approval, and `"inReplyTo"` set to the approval's `messageId`, so you can match the two. Countdown refreshes are not sent.

**HMAC verification** — with `signing_secret_ref` set, every POST carries
`X-Foreman-Timestamp` (Unix seconds) and `X-Foreman-Signature`, an
HMAC-SHA256 over the timestamp, a dot and the raw body. Receivers should
check both, and refuse a timestamp more than 5 minutes from their own clock,
so a captured delivery can't be replayed later:

```js
const ts = req.headers["x-foreman-timestamp"];
if (!/^\d+$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > 300) {
  return reject("stale or missing timestamp");
}
const expected = "sha256=" + hmacSha256(SIGNING_SECRET, `${ts}.${rawBody}`);
if (!constantTimeEqual(expected, req.headers["x-foreman-signature"])) {
  return reject("invalid signature");
}
```

Inside that window a receiver that must never act twice should also drop a
`messageId` it has already seen. (Before #656 the signature covered the body
only; update receivers that verify it.)

Webhook, Slack, Discord and ntfy URLs must be `https://`; plain `http://`
is accepted only to this machine (`localhost`, `127.0.0.0/8`, `::1`). A URL
with a user name or password in it is refused, and errors never repeat the
URL.

**No callback support yet** — Foreman doesn't run an inbound HTTP server in v0.1, so webhooks are delivery-only. A bidirectional flow (your automation POSTs back a decision) needs significant new infrastructure; tracked as a follow-up.

### System — macOS / Linux native notifications

Spawns `osascript "display notification …"` on macOS or `notify-send` (libnotify) on Linux. Useful as a heads-up *while you're at the terminal* — "you have a pending approval in the TUI". Native OS notifications don't support reliable button-callback capture from a CLI-spawned process, so this is outbound-only too.

```yaml
channels:
  system:
    enabled: true
```

```bash
foreman notify enable system
foreman notify test system
# → look for a banner in your top-right corner (macOS) or notification area (Linux)
```

Windows support is deferred to v0.2 (PowerShell BurntToast).

---

## 3c. Silence, mute, daily digest (C11c)

### Silence — temporary "stop pinging me" window

```bash
foreman notify silence 4h          # mute non-critical for 4 hours
foreman notify silence 30m         # short window during a meeting
foreman notify unsilence           # clear early
```

**Critical alerts still fire.** Silence drops `warning` / `info` / `summary` / `budget_alert` only — phishing / loop / catastrophic shell calls still wake you up. The window persists in `~/.foreman/notify-state.json`; the bridge re-reads on every dispatch so the silence takes effect without restart.

### Mute — never alert about a specific agent

```bash
foreman notify mute hermes         # don't alert about hermes' calls
foreman notify unmute hermes
```

Useful when an agent does benign-but-noisy background work (calendar sync, log scraping). The mute applies to alerts only — `foreman log show` still records every call.

### Daily digest

When `routing.summary.schedule` is set (default `"daily 20:00"`) and the route has at least one channel, Foreman fires a digest every day at that wall-clock time. Currently uses a **honest-fallback template** that counts:

- Total tool calls / agents active
- Allowed vs denied
- High-risk calls flagged
- Notifications delivered (excluding prior digests)

Footer: *"Smart analysis is off. Enable with `foreman llm enable` for contextual reports."* When C8 (LLM verification) + C9 (smart report) ship, the prose narrative comes from the model — for v0.1, you get counts + a hint.

```bash
foreman notify summary             # print the digest body to stdout (preview)
foreman notify summary --now       # send it now on every channel routed for summary
foreman notify summary --hours 24  # widen the window from the default 12h
```

The scheduler runs **only when `foreman start` is running** (it lives next to the approval bridge). Restart-after-target catches up — if you boot Foreman at 21:00 and the schedule is `daily 20:00`, you get today's digest on the next tick.

---

## 4. CLI

```bash
foreman notify status                  # enabled channels + last 5 notifications + active silence/mute
foreman notify enable <channel>        # toggle channel on (telegram / webhook / system)
foreman notify disable <channel>       # toggle channel off (keeps credentials)
foreman notify test <channel>          # send a test alert (bypasses routing)

foreman notify silence 4h              # mute non-critical for 4 hours
foreman notify unsilence               # clear active silence window
foreman notify mute <agent>            # don't alert about a specific source agent
foreman notify unmute <agent>          # re-enable alerts for the agent
foreman notify summary                 # print today's digest to stdout
foreman notify summary --now           # send today's digest now on every routed channel
foreman notify summary --hours <n>     # widen the digest window (default 12)

# Coming in C11b-2
foreman notify route critical --channels=telegram,slack
foreman notify timeout critical --seconds=120
```

---

## 5. Security model

| Threat | Mitigation |
|---|---|
| **Channel hijack** — anyone with the bot token can send / receive | Token stays in Foreman's encrypted secret store. The configured `chat_id` constraint means even if the bot lands in a group, only YOUR taps are honored. |
| **Replay attack** — replays of an old "approved" callback | Every callback's `notificationId` is checked against the outstanding-message map. Once resolved, the id is dropped — replays are silently rejected. |
| **Compromised bot token** — attacker has the token, sends fake approvals | Every callback verifies (a) it's from the configured chat_id, (b) it targets a real outstanding notification id. A spoofed callback for a non-existent notification is dropped. |
| **Two-way Slack / Discord** — someone else in the channel presses a button, or a forged payload | Only `allowed_user_ids` can act; others get a private refusal. Button values carry an HMAC tag bound to the approval and the action, signed with a key of their own: an agent that can read Slack or Discord history can't replay one through `submit_approval`. Payloads arrive over a Socket Mode / Gateway connection opened with a token only Foreman holds, and Slack replies go only to `hooks.slack.com`. A stale button (approval already decided) is refused. |
| **Relaying chat agent** — an agent that shares the bot reads the approval buttons after any tap | Use the approval bot (`foreman notify approval-bot`): approvals go through a bot only Foreman holds and polls, so no agent sees them. Without it, relayed allows still need the button's HMAC tag, but the relay agent itself can read the keyboard (see SECURITY.md). |
| **Network unavailable** — Telegram is down | `NotificationService` records the failed delivery in the `notifications` table with `status='failed'` + the error message. `foreman doctor` surfaces channel health. |

---

## 6. How it's wired

```
mediator.handleRequest()
   │ risk.assess() + needsApproval
   │
   ├─► bus.emit('approval:requested', …)
   │      │
   │      ▼
   │   NotificationBridge.bus.on('approval:requested')
   │      │
   │      ▼
   │   NotificationService.send(level, payload)
   │      │
   │      ├─ routeFor(level) → which channels?
   │      ├─ each enabled channel: channel.send(notification)
   │      ├─ persist `notifications` row + `notification_messages` row
   │
   ▼
await approval.request(...)   ← mediator blocks here
   │
   │  [user taps Allow/Deny on Telegram OR in the TUI]
   │
   │  TUI path: KeyboardHandler → bus.emit('approval:resolved')
   │  OOB path: TelegramChannel poll → onDecision(d)
   │              → NotificationBridge.onAnyDecision(d)
   │                  → bus.emit('approval:resolved')
   │
   │  First decision wins. Bridge ALSO listens for 'approval:resolved'
   │  → channel.updateMessage(ref, "… resolved elsewhere") so the
   │     loser's channel reflects the final state.
   │
   ▼
mediator finalize + return to agent
```

C11a-2 ships the **`NotificationBridge`** — the missing wire from `onAnyDecision` back to `bus.emit('approval:resolved')`. Cross-process flow (mcp-stdio / wrap) works via the existing `DbApprovalService` + `ApprovalBridge` (#117): pending_approvals row → start.ts's bus → notification → tap → bus.emit('approval:resolved') → DbApprovalService poll picks up.

---

## 7. C11 sub-issue plan

| PR | Scope | Status |
|---|---|---|
| C11a-1 | Foundation: notify.yaml + NotificationService + TelegramChannel + CLI + migration + doctor | shipped |
| C11a-2 | Mediator wire: NotificationBridge bridges bus ↔ channels; OOB tap unblocks the agent; "resolved elsewhere" update on race | shipped |
| C11b-1 | Webhook (HMAC-signed outbound) + System (macOS osascript / Linux notify-send) channels | shipped |
| **C11c** (this) | Daily digest scheduler + silence / mute commands + state persistence | shipped |
| C11b-2 | Discord (interactive components) + Slack (Block Kit, socket mode) — bidirectional channels | last slice |

---

## 8. Sources

- [Telegram Bot API — inline keyboards + callback queries](https://core.telegram.org/bots/api)
- [PagerDuty / OpsGenie / VictorOps](https://www.pagerduty.com/) — out-of-band incident workflows, the spiritual model for "Foreman pauses the agent until you decide"
- [Apprise (Python)](https://github.com/caronc/apprise) — multi-channel notification reference


---

## Channel setup

| Channel | Credentials | Notes |
| --- | --- | --- |
| Telegram | `foreman secrets add telegram-bot-token` + `chat_id` | Interactive: inline Allow / Deny buttons carry an HMAC-tagged approval id. Only the typed `/deny` fallback appears in the text. Other agents can't approve; for the chat agent's own calls, see [SECURITY.md](../SECURITY.md#threat-model-in-brief). |
| Slack | incoming webhook URL → `foreman secrets add slack-webhook-url` | Or `bot_token_ref` + `channel` (needs `chat:write`). Agent text is escaped (no `<!channel>` pings). Two-way: [§3a](#3a-two-way-slack-and-discord-615). |
| Discord | channel webhook URL → `foreman secrets add discord-webhook-url` | Or `bot_token_ref` + `channel` id. Mentions are always disabled. Two-way (bot only): [§3a](#3a-two-way-slack-and-discord-615). |
| Email | `foreman secrets add smtp-app-password` | Gmail / iCloud / Fastmail need an app password. Credentials are never sent over an unencrypted connection to a remote host. |
| ntfy | `foreman notify ntfy-setup` | Install the ntfy app and subscribe to the printed topic. Self-host ntfy or set `access_token_ref` for stricter privacy. |
| Webhook | `webhook_url_ref` (+ `signing_secret_ref`) | JSON POST with `X-Foreman-Timestamp` and `X-Foreman-Signature: sha256=…` over `<timestamp>.<body>`. |

Then route levels to channels:

```bash
foreman notify route critical telegram ntfy
foreman notify route summary email slack
foreman notify status
foreman doctor        # notify_channels: flags enabled-but-unbuildable or unrouted channels
```
