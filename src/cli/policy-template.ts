// Smart defaults shipped by `foreman init`. Aim: a user gets meaningful
// protection without writing a single rule. See FOREMAN.md §3.7 for the
// full schema; this file is intentionally short (well under 80 lines) so
// it reads as a single screen on first encounter.
export const DEFAULT_POLICY_YAML = `# Foreman default policy — edit and re-run 'foreman start' to apply.
# Schema reference: FOREMAN.md §3.7

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

  # Same guard rail on writes.
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
  # win over these because conditional rules sort ahead of blanket allows.
  - source: "*"
    target: "tool:list_files"
    effect: allow
  - source: "*"
    target: "tool:stat"
    effect: allow
  - source: "*"
    target: "tool:read_file"
    effect: allow

# Per-agent rules and rate limits go here. Example:
#
# agents:
#   hermes:
#     can_call:
#       claude-code: [read_file, list_files]
#     cannot_call:
#       claude-code: [write_file, shell_exec]
#     rate_limits:
#       messages_per_minute: 30
#       tokens_per_hour: 100000

# Responsibility-based policies — orthogonal to the agent rules above.
# Foreman checks every tool call against the source agent's responsibility
# note (set in 'foreman setup' or 'foreman agent edit'). If the action is
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
