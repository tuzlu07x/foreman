# Out-of-band notifications (#235 — C11)

How Foreman reaches you when you're not at the terminal. **Telegram-first** for v0.1; Discord / Slack / Webhook / System notifications ship in C11b. Daily digest + silence / mute commands in C11c.

This doc covers the **C11a-1 foundation slice**: config, Telegram channel, CLI, audit persistence. The mediator-blocking flow (agent paused until you tap Allow/Deny) lands in C11a-2.

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

  # Discord / Slack — placeholders, implemented in C11b-2 (next slice)
  discord:
    enabled: false
  slack:
    enabled: false

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

---

## 3b. Webhook + System channels (C11b-1)

Two **outbound-only** channels for deployments that want delivery without bidirectional callbacks. They send alerts but can't capture user decisions — pair them with Telegram (or the TUI) for the actual deciding.

### Webhook — generic HTTP POST integration

Routes every notification as a JSON POST to your configured URL. Suitable for Discord/Slack-incoming webhooks, n8n / Zapier / PagerDuty, or your own relay.

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
  "sentAt": 1779800000000
}
```

**HMAC verification** — receivers should validate:

```js
const expected = "sha256=" + hmacSha256(SIGNING_SECRET, rawBody);
if (!constantTimeEqual(expected, req.headers["x-foreman-signature"])) {
  return reject("invalid signature");
}
```

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

## 4. CLI

```bash
foreman notify status                  # enabled channels + last 5 notifications
foreman notify enable <channel>        # toggle channel on (telegram only for now)
foreman notify disable <channel>       # toggle channel off (keeps credentials)
foreman notify test telegram           # send a test alert

# Coming in C11a-2 / C11b / C11c
foreman notify route critical --channels=telegram,slack
foreman notify timeout critical --seconds=120
foreman notify silence 4h              # mute non-critical for 4 hours
foreman notify summary --now           # force-send today's digest
foreman notify mute hermes             # don't alert about this agent
```

---

## 5. Security model

| Threat | Mitigation |
|---|---|
| **Channel hijack** — anyone with the bot token can send / receive | Token stays in Foreman's encrypted secret store. The configured `chat_id` constraint means even if the bot lands in a group, only YOUR taps are honored. |
| **Replay attack** — replays of an old "approved" callback | Every callback's `notificationId` is checked against the outstanding-message map. Once resolved, the id is dropped — replays are silently rejected. |
| **Compromised bot token** — attacker has the token, sends fake approvals | Every callback verifies (a) it's from the configured chat_id, (b) it targets a real outstanding notification id. A spoofed callback for a non-existent notification is dropped. |
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
| **C11b-1** (this) | Webhook (HMAC-signed outbound) + System (macOS osascript / Linux notify-send) channels | shipped |
| C11b-2 | Discord (interactive components) + Slack (Block Kit, socket mode) — bidirectional channels | follow-up |
| C11c | Daily digest scheduler + silence / mute commands | follow-up |

---

## 8. Sources

- [Telegram Bot API — inline keyboards + callback queries](https://core.telegram.org/bots/api)
- [PagerDuty / OpsGenie / VictorOps](https://www.pagerduty.com/) — out-of-band incident workflows, the spiritual model for "Foreman pauses the agent until you decide"
- [Apprise (Python)](https://github.com/caronc/apprise) — multi-channel notification reference
