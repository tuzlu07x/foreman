# v0.1.0 launch checklist

This is the operational playbook for shipping `foreman-agent@0.1.0` to npm and the soft launch that follows. Top to bottom, one pass.

## Pre-release sanity

- [x] `tsup.config.ts` finalized (ESM, shebang preserved, treeshake on)
- [x] `package.json` — `version: 0.1.0`, `bin`, `files`, `engines.node: >=20`, keywords aligned with GitHub topics
- [x] In-code version strings (CLI, TUI status bar, MCP server) bumped to `0.1.0`
- [x] `npm run lint` clean (`tsc --noEmit`)
- [x] `npm test` clean (full vitest suite)
- [x] `npm run build` clean — `dist/cli/index.js` has `#!/usr/bin/env node` and executable bit
- [x] `npm pack --dry-run` reviewed — only `dist/`, `*.md`, `LICENSE`, `package.json` ship
- [x] `npm publish --dry-run` clean
- [x] README hero image uses absolute GitHub raw URL (renders on npmjs.com)
- [ ] **GitHub repo Settings → Social preview** — upload `assets/social/og-card.png` (carryover from #27)
- [ ] **Asciinema cast** — record via `examples/phishing-scenario/run-demo.sh`, upload, paste embed in README placeholder (carryover from #27)

## Tag and GitHub release

```bash
# from main, after the publish-prep PR is merged
git checkout main && git pull
git tag -a v0.1.0 -m "v0.1.0 — initial release"
git push origin v0.1.0

# auto-generate release notes from merged PRs
gh release create v0.1.0 --generate-notes --title "v0.1.0 — initial release"
```

If the auto-generated notes are noisy, edit them in the GitHub UI after creation — keep the "What's new" punchy, hide the per-PR list under a collapsible if needed.

## npm publish

```bash
# one-time login if you haven't published from this machine
npm login

# verify the right account + scope
npm whoami

# real publish (no dry-run flag this time)
npm publish

# confirm
npm view foreman-agent version
```

If publish fails because the name is taken, check the registry and either claim an unscoped name variant or use `@tuzlu07x/foreman-agent`. Update `package.json#name` and `README.md` install line, then republish.

## Smoke test the published package

On a clean machine (or a fresh Docker container — `docker run --rm -it node:20 bash`):

```bash
npm install -g foreman-agent
foreman --version          # should print 0.1.0
foreman init               # should populate ~/.foreman/
foreman start              # TUI boots, identity loaded, MCP gateway up
```

If `foreman start` fails on a non-TTY environment, that's expected — the smoke test is for an interactive shell.

## Soft launch posts

Each post below is a draft. Read it in your own voice, trim, then publish. Keep them short — the asciinema does the heavy lifting.

### Show HN

**Title:** `Show HN: Foreman – a terminal-first guardian for your local AI agents`

**Body:**
```
Hi HN — I built Foreman because my laptop suddenly had three AI agents
(Claude Code, a Hermes-style assistant, a custom MCP server) and none of
them knew the others existed. No shared memory, no audit trail, no
control layer.

Foreman is a single Node process that sits between your local agents and
mediates every MCP call. It scores each request for risk (secret-file
patterns, outbound network, shell exec, cross-agent calls), and when the
score crosses a threshold it asks you in the terminal before forwarding.
Everything lands in a local SQLite log with FTS5 audit search.

The README has a 3-minute asciinema of the phishing scenario it was
built for: an email tells the assistant agent to share .env, Foreman
flags it at risk 80/100, you press `i` to inspect, `d` to deny.

Tech: TypeScript, MCP SDK, better-sqlite3, drizzle, Ink for the TUI,
Ed25519 identities for each agent. MIT, requires Node 20+.

  npm install -g foreman-agent
  foreman init && foreman start

Roadmap is v0.2 cross-machine mesh, v0.3 LLM-based risk scoring, v0.4
plugin / Cedar policy. Feedback very welcome — especially scenarios
that should trip the risk scorer that currently don't.

https://github.com/tuzlu07x/foreman
```

### r/LocalLLaMA

**Title:** `[Project] Foreman: terminal guardian that audits + gates calls between your local AI agents`

**Body:**
```
If you're running Hermes/Claude Code/local LLM agents side-by-side, you
probably noticed they're islands — no shared context, no log of what
they did when you weren't looking.

Foreman is a local gateway that sits in front of them. It speaks MCP,
proxies every call, scores it for risk, and asks before anything spicy
goes through. Audit log is SQLite with FTS5 so you can search "what
did claude-code touch in .env this week" later.

All local. No telemetry. MIT.

Sample flow (full asciinema in the README): phishing email →
assistant agent tries to read .env → Foreman flags risk 80/100 → I
press `d` to deny, then `r` to remember the rule.

Repo: https://github.com/tuzlu07x/foreman
Install: npm install -g foreman-agent

Looking for feedback from people running multi-agent setups locally —
especially what risk signals you'd want it to pick up that it doesn't yet.
```

### Twitter / X thread

```
1/  shipped v0.1 of foreman-agent today —
    a terminal-first guardian for your local AI agents.

    the pitch: your agents talk to each other.
    you should know what they're saying.

    [asciinema cast embed]

2/  it sits between hermes / claude code / your custom MCP servers
    and mediates every call. ed25519 identity per agent, MCP under
    the hood, sqlite + FTS5 audit log.

    risk scorer flags secret-file patterns, outbound network calls,
    shell exec, cross-agent first-contact, previously-denied patterns.

3/  when a request crosses the threshold, foreman asks in the terminal:
    [a]llow / [d]eny / [r]emember.
    "remember" writes a policy rule. next time it's just policy.

    everything goes through ink TUI. mascot is a chibi beaver in a
    hard hat because beavers are nature's foremen, fight me.

4/  v0.1 is single-machine. v0.2 is cross-machine mesh. v0.3 is
    optional LLM-based risk scoring (llama prompt guard 2). v0.4 is
    plugin API + cedar policy.

    npm install -g foreman-agent
    github.com/tuzlu07x/foreman

5/  feedback / issues / PRs welcome. especially:
    - what risk signal does it miss?
    - what's the rough edge in 'foreman init'?
    - is the approval modal copy clear?

    🦫
```

### Discord (MCP community, Anthropic Discord, etc.)

Short version, link to README does the work:

```
Just shipped v0.1 of Foreman — terminal gateway that sits between local
AI agents and mediates every MCP call. Risk scoring + approval prompt +
SQLite audit log, all local. MIT.

If you're running multi-agent setups locally and want a control layer
instead of trust-by-default, give it a spin and tell me where it
breaks.

→ https://github.com/tuzlu07x/foreman
```

## Post-launch

- [ ] Watch the GitHub Issues tab for the first 48 hours. Reply to every issue, even "doesn't work on my machine" ones.
- [ ] Pin a Discussion ("v0.1 feedback thread") so people don't open duplicate issues for the same friction.
- [ ] If a critical bug surfaces, patch + `v0.1.1` within 24h. Don't sit on it.
- [ ] After the first week, snapshot: stars, installs (`npm view foreman-agent`), issues opened, PRs from non-owners. Compare against the success criteria in `FOREMAN.md` §14.

## If something goes wrong

- **`npm publish` fails with `EPUBLISHCONFLICT`:** the name is taken on the registry. Switch to `@tuzlu07x/foreman-agent`, republish, update README install line.
- **`npm publish` succeeds but install on a clean machine fails:** check `files` in `package.json` — most likely a runtime file (migration, asset) is missing from the tarball. Fix, bump to `0.1.1`, republish.
- **CRITICAL post-release bug:** `npm unpublish foreman-agent@0.1.0` is possible within 72 hours, but prefer `npm deprecate` + ship `0.1.1`. Unpublishing breaks anyone who pinned the bad version.
