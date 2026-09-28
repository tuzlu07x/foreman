// Smart defaults shipped by `foreman init`. Aim: a user gets meaningful
// protection without writing a single rule. The schema is documented in
// docs/policy.md (linked from the header, since docs/ isn't in the npm
// package); this file stays short so it reads as a single screen.
export const DEFAULT_POLICY_YAML = `# Foreman default policy. Edits apply on the next call: a running
# 'foreman start' and your agents' connections pick them up, no restart.
# Schema reference: https://github.com/tuzlu07x/foreman/blob/main/docs/policy.md

rules:
  # Ask before any agent reads files that look like secrets.
  - source: "*"
    target: "tool:read_file"
    effect: ask
    conditions:
      pathMatch:
        - "(^|/)\\\\.env(\\\\..*)?$"
        - "\\\\.key$"
        - "(^|/)id_rsa(\\\\.pub)?$"
        - "(^|/)id_ed25519(\\\\.pub)?$"
        - "(^|/)\\\\.npmrc$"
        - "/\\\\.ssh/"
        - "/\\\\.aws/credentials$"

  # Same guard rail on writes: MCP servers call it write_file, the Claude
  # Code hook and Codex report file_write.
  - source: "*"
    target: "tool:write_file"
    effect: ask
    conditions:
      pathMatch:
        - "(^|/)\\\\.env(\\\\..*)?$"
        - "\\\\.key$"
        - "(^|/)id_rsa(\\\\.pub)?$"
        - "(^|/)id_ed25519(\\\\.pub)?$"
        - "/\\\\.ssh/"
        - "/\\\\.aws/credentials$"
  - source: "*"
    target: "tool:file_write"
    effect: ask
    conditions:
      pathMatch:
        - "(^|/)\\\\.env(\\\\..*)?$"
        - "\\\\.key$"
        - "(^|/)id_rsa(\\\\.pub)?$"
        - "(^|/)id_ed25519(\\\\.pub)?$"
        - "/\\\\.ssh/"
        - "/\\\\.aws/credentials$"

  # Ask before destructive or pipe-to-shell commands.
  - source: "*"
    target: "tool:shell_exec"
    effect: ask
    conditions:
      commandMatch:
        - "rm -rf"
        - "chmod 777"
        - ":(){:|:&};:"
        - "| sh"
        - "| bash"
        - "curl"
        - "wget"

  # Permissive defaults for harmless read-only ops. Secret-shaped reads above
  # still ask: a targeted (conditional) rule outranks a blanket one.
  - source: "*"
    target: "tool:list_files"
    effect: allow
  - source: "*"
    target: "tool:stat"
    effect: allow
  - source: "*"
    target: "tool:read_file"
    effect: allow

# MCP connections without a valid agent token run as untrusted:<id>
# ('foreman agent rewire' fixes them). ask (default): nothing is
# auto-allowed for them. deny: quarantine them. allow_wildcards: the
# "*" allow rules above apply to them too.
#
# identity:
#   untrusted: ask

# Per-agent rules and rate limits go here. can_call / cannot_call cover
# what one agent does to another: handing it work is "write". Example:
#
# agents:
#   hermes:
#     can_call:
#       claude-code: [write]
#     cannot_call:
#       codex: [write]
#     rate_limits:
#       messages_per_minute: 30
#       tokens_per_hour: 100000

# Responsibility-based policies — orthogonal to the agent rules above.
# Foreman checks every tool call against the source agent's responsibility
# note (set in 'foreman setup', on the TUI Agents page with N, or with
# 'foreman agent responsibility <id> "<note>"'). If the action is
# outside the declared role, the risk score is bumped and the approval
# modal calls out the role mismatch.
#
# Starter set covers four common roles. Add / edit / delete to match
# your own agent inventory.
responsibility_policies:
  - responsibility: "code writing"
    cannot_access:
      - "/\\\\.ssh/"
      - "/\\\\.aws/"
      - "^/etc/passwd$"
      - "^/etc/shadow$"
    can_call_agents_with_responsibility:
      - "code review"
      - "testing"
    cannot_call_agents_with_responsibility:
      - "email management"
      - "payment processing"

  - responsibility: "project management"
    cannot_access:
      - "(^|/)\\\\.env(\\\\..*)?$"
    can_call_agents_with_responsibility:
      - "code writing"
      - "code review"
      - "testing"
    can_use_services:
      - github
      - jira
      - telegram

  - responsibility: "code review"
    cannot_access:
      - "/\\\\.ssh/"
      - "/\\\\.aws/"
    can_call_agents_with_responsibility:
      - "testing"

  - responsibility: "document analysis"
    cannot_access:
      - "(^|/)\\\\.env(\\\\..*)?$"
      - "/\\\\.ssh/"
    can_use_services:
      - notion
      - telegram
`;
