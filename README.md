# Foreman

```
       ___[F]___
      /         \
     |__/ o   o \__|
        |  \_/  |
       /|_______|\
      / |==VEST=| \
     /__|=======|__\
        |_______|

    Foreman — your agent guardian
```

**Your local AI agents talk to each other. You should know what they're saying.**

A terminal-first guardian that sits between your AI agents and makes sure none of them does anything you didn't approve.

---

## What is this?

Foreman is a local, terminal-first **gateway** that mediates every call between the AI agents running on your machine (Hermes, Claude Code, custom MCP servers, your own scripts). It:

- **Registers** each agent with an Ed25519 identity.
- **Mediates** every call agent → agent and agent → tool through itself.
- **Scores** each request for risk (heuristic-first: secret-file patterns, outbound network, shell exec, cross-agent calls, …).
- **Asks you** in the terminal whenever a request crosses the risk threshold: `[a]llow / [d]eny / [r]emember`.
- **Logs everything** to SQLite (with FTS5 full-text audit search).

If a phishing email tells your assistant agent to share your `.env`, Foreman sees it, scores it 80/100, and asks you before anything leaves your machine.

## Status

Pre-MVP — repo just opened. Target: **v0.1.0**.

See [`FOREMAN.md`](./FOREMAN.md) for the full design doc and [`FOREMAN-TUI.md`](./FOREMAN-TUI.md) for the TUI / brand spec.

## License

MIT (coming soon).
