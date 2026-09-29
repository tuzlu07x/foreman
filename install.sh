#!/usr/bin/env bash

set -euo pipefail

REPO="tuzlu07x/foreman"
PACKAGE="foreman-agent"
# Node 20 reached end-of-life on 2026-04-30 and Foreman's dependencies
# (ink 7, commander 15) require >= 22.12.
MIN_NODE_MAJOR=22
NODE_LTS_MAJOR=22
SUPPORTED_NODE_MAJORS="22, 24"
NVM_VERSION="${FOREMAN_NVM_VERSION:-v0.40.1}"

# Colours (TTY only).
if [ -t 2 ]; then
  c_red=$'\033[31m'
  c_green=$'\033[32m'
  c_orange=$'\033[38;2;255;140;66m'
  c_dim=$'\033[2m'
  c_bold=$'\033[1m'
  c_reset=$'\033[0m'
else
  c_red=""; c_green=""; c_orange=""; c_dim=""; c_bold=""; c_reset=""
fi

log()  { printf "%s\n" "$*" >&2; }
ok()   { printf "  %s✓%s %s\n" "${c_green}" "${c_reset}" "$*" >&2; }
warn() { printf "  %s⚠%s %s\n" "${c_orange}" "${c_reset}" "$*" >&2; }
err()  { printf "  %s✗%s %s\n" "${c_red}" "${c_reset}" "$*" >&2; }
step() { printf "\n%s>>%s %s\n" "${c_orange}" "${c_reset}" "$*" >&2; }

usage() {
  cat <<EOF
${c_bold}Foreman installer${c_reset} — installs ${PACKAGE} globally via npm.

${c_bold}USAGE${c_reset}
  curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | bash
  curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | bash -s -- --uninstall

${c_bold}FLAGS${c_reset}
  --uninstall     Remove Foreman: the background service, Foreman's entries in
                  your agents' configs (MCP server, Claude Code hook) and the
                  ${PACKAGE} package. Asks before deleting Foreman's data.
  --purge         With --uninstall: also delete Foreman's data (identity,
                  policy, audit log, stored secrets) without asking
  --help, -h      Show this help

${c_bold}ENVIRONMENT${c_reset}
  FOREMAN_INSTALL_PREFIX    npm prefix override
  FOREMAN_VERSION           specific version (default: latest published)
  FOREMAN_SKIP_NVM          set to 1 to refuse the nvm bootstrap path
  FOREMAN_REUSE_ANY_NODE    set to 1 to reuse a Node >=22 outside the tested
                            LTS lines (${SUPPORTED_NODE_MAJORS}); may require a C/C++ toolchain
  FOREMAN_NVM_DEFAULT       1: make Node ${NODE_LTS_MAJOR} your nvm default without asking;
                            0: leave the default alone (see below)

When the installer has to switch to Node ${NODE_LTS_MAJOR} through nvm while your nvm
default is another Node, new terminals won't find 'foreman'. It says so,
and in a terminal asks whether to make Node ${NODE_LTS_MAJOR} the default.
EOF
}

# A yes/no question on the terminal, even under `curl | bash` (stdin is
# the script). $2 (y or n) is what Enter means. Without a terminal the
# answer is no: nothing of yours changes unasked.
# ASK_TTY is the terminal; tests point it at a file holding the answer.
ASK_TTY=/dev/tty
ask() {
  local question="$1" default="${2:-n}" reply=""
  if ! ( : <"${ASK_TTY}" ) 2>/dev/null; then
    return 1
  fi
  local hint="[y/N]"
  [ "${default}" = "y" ] && hint="[Y/n]"
  printf "  %s?%s %s %s " "${c_orange}" "${c_reset}" "${question}" "${hint}" >>"${ASK_TTY}"
  read -r reply <"${ASK_TTY}" || reply=""
  # Drop spaces and a stray carriage return around the answer.
  reply=$(printf "%s" "${reply}" | tr -d ' \t\r')
  case "${reply}" in
    [Yy]*) return 0 ;;
    [Nn]*) return 1 ;;
    *) [ "${default}" = "y" ] ;;
  esac
}

current_node_major() {
  if ! command -v node >/dev/null 2>&1; then
    echo 0
    return
  fi
  node --version 2>/dev/null | sed -e 's/^v//' -e 's/\..*$//' || echo 0
}

is_supported_node_major() {
  case "${1:-0}" in
    22|24) return 0 ;;
    *) return 1 ;;
  esac
}

ensure_node() {
  local major
  major=$(current_node_major)

  if is_supported_node_major "${major}"; then
    ok "Node $(node --version) detected — reusing it"
    return 0
  fi

  if [ "${major:-0}" -ge "${MIN_NODE_MAJOR}" ] && [ "${FOREMAN_REUSE_ANY_NODE:-0}" = "1" ]; then
    warn "Node $(node --version) is outside the tested LTS lines (${SUPPORTED_NODE_MAJORS}) — reusing it because FOREMAN_REUSE_ANY_NODE=1"
    warn "If 'npm install' fails to build native modules, install Node ${NODE_LTS_MAJOR} LTS and re-run."
    return 0
  fi

  if [ "${FOREMAN_SKIP_NVM:-0}" = "1" ]; then
    err "Node ${NODE_LTS_MAJOR} LTS required (found: ${major:-none}) but FOREMAN_SKIP_NVM=1"
    err "Install Node ${NODE_LTS_MAJOR} (https://nodejs.org/en/download) then re-run the installer."
    exit 1
  fi

  # Node 22 may already be installed through nvm, just not the active one:
  # then the installer only switches to it.
  local installed=0 found="none"
  if nvm_has_lts; then installed=1; fi
  if command -v node >/dev/null 2>&1; then found=$(node --version 2>/dev/null || echo none); fi
  if [ "${installed}" = "1" ] && [ "${major:-0}" -ge "${MIN_NODE_MAJOR}" ]; then
    warn "Node ${found} has no prebuilt native binaries — switching to the Node ${NODE_LTS_MAJOR} LTS you already have through nvm"
  elif [ "${installed}" = "1" ]; then
    warn "Node ${NODE_LTS_MAJOR} LTS is installed through nvm but not active (this shell has: ${found}) — switching to it"
  elif [ "${major:-0}" -ge "${MIN_NODE_MAJOR}" ]; then
    warn "Node ${found} has no prebuilt native binaries — installing Node ${NODE_LTS_MAJOR} LTS via nvm so you don't need a compiler"
  else
    warn "Node ${NODE_LTS_MAJOR} LTS not detected — installing it via nvm (no Python / build tools required)"
  fi
  bootstrap_nvm

  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ ! -s "${NVM_DIR}/nvm.sh" ]; then
    err "nvm install completed but ${NVM_DIR}/nvm.sh is missing"
    err "Open a new shell and re-run this installer, or install Node manually."
    exit 1
  fi
  set +u
  # shellcheck disable=SC1091
  . "${NVM_DIR}/nvm.sh"
  if [ "${installed}" != "1" ]; then
    nvm install "${NODE_LTS_MAJOR}" >&2
  fi
  nvm use "${NODE_LTS_MAJOR}" >&2
  set -u
  ok "Node $(node --version) ready via nvm"
  SWITCHED_NODE=1
}

# Whether nvm already holds a Node ${NODE_LTS_MAJOR} (under $NVM_DIR/versions/node).
nvm_has_lts() {
  local dir
  for dir in "${NVM_DIR:-$HOME/.nvm}"/versions/node/v"${NODE_LTS_MAJOR}".*; do
    if [ -x "${dir}/bin/node" ]; then return 0; fi
  done
  return 1
}

# After switching Node through nvm: new terminals start with nvm's default
# Node, where foreman isn't installed, unless that is a supported one too.
# Say so, and offer to change the default.
check_default_node() {
  [ "${SWITCHED_NODE:-0}" = "1" ] || return 0
  local default_major
  default_major=$(set +u; nvm version default 2>/dev/null | sed -e 's/^v//' -e 's/\..*$//' || true)
  if is_supported_node_major "${default_major}"; then
    DEFAULT_NODE_OK=1
    return 0
  fi
  local current="${default_major:-none}"
  [ "${current}" = "N/A" ] && current="none"
  warn "Your nvm default is Node ${current}, so new terminals won't find 'foreman' (it is installed for Node ${NODE_LTS_MAJOR})."
  local decide="${FOREMAN_NVM_DEFAULT:-}"
  if [ "${decide}" = "1" ] || { [ -z "${decide}" ] && ask "Make Node ${NODE_LTS_MAJOR} your nvm default (nvm alias default ${NODE_LTS_MAJOR})" y; }; then
    # nvm's functions don't expect errexit/nounset: run it without them
    # and check the result, so a hiccup can't end the installer silently.
    if (set +eu; nvm alias default "${NODE_LTS_MAJOR}" >/dev/null 2>&1); then
      ok "Node ${NODE_LTS_MAJOR} is now your nvm default: new terminals will find 'foreman'"
      DEFAULT_NODE_OK=1
      return 0
    fi
    warn "Couldn't change your nvm default. Run it yourself: nvm alias default ${NODE_LTS_MAJOR}"
    return 0
  fi
  warn "Left your default alone. In each new terminal run: nvm use ${NODE_LTS_MAJOR}"
  warn "Or once: nvm alias default ${NODE_LTS_MAJOR}"
}

bootstrap_nvm() {
  if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
    ok "nvm already installed at ${NVM_DIR:-$HOME/.nvm}"
    return 0
  fi
  if ! command -v curl >/dev/null 2>&1; then
    err "curl is required to fetch the nvm installer"
    exit 1
  fi
  local installer
  installer=$(mktemp -t foreman-nvm-XXXXXX)
  if ! curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh" -o "${installer}"; then
    rm -f "${installer}"
    err "failed to download nvm ${NVM_VERSION} installer"
    err "manual: see https://github.com/nvm-sh/nvm#installing-and-updating"
    exit 1
  fi
  bash "${installer}"
  rm -f "${installer}"
}

npm_install_foreman() {
  local target="${PACKAGE}"
  if [ -n "${FOREMAN_VERSION:-}" ]; then
    target="${PACKAGE}@${FOREMAN_VERSION}"
  fi
  step "Installing ${target} globally via npm"
  if [ -n "${FOREMAN_INSTALL_PREFIX:-}" ]; then
    npm install --prefix "${FOREMAN_INSTALL_PREFIX}" -g "${target}"
  else
    npm install -g "${target}"
  fi
  ok "npm install -g ${target} succeeded"
}

verify_install() {
  step "Verifying install"
  if ! command -v foreman >/dev/null 2>&1; then
    warn "foreman not on PATH yet"
    warn "If you bootstrapped through nvm, open a new shell or run:"
    warn "  export NVM_DIR=\"\$HOME/.nvm\" && . \"\$NVM_DIR/nvm.sh\""
    warn "Otherwise: export PATH=\"\$(npm prefix -g)/bin:\$PATH\""
    return 1
  fi
  local v
  v=$(foreman --version 2>&1 || true)
  ok "foreman --version: ${v}"
}

next_steps() {
  printf "\n%sNext:%s\n" "${c_bold}" "${c_reset}"
  # The installer switched Node for itself only: the terminal that ran it
  # still has the old Node on PATH, where 'foreman' isn't installed.
  if [ "${SWITCHED_NODE:-0}" = "1" ]; then
    if [ "${DEFAULT_NODE_OK:-0}" = "1" ]; then
      printf "  0. %snvm use %s%s          first (or open a new terminal): this terminal still runs your old Node\n" "${c_orange}" "${NODE_LTS_MAJOR}" "${c_reset}"
    else
      printf "  0. %snvm use %s%s          first, here and in each new terminal: 'foreman' is installed for Node %s\n" "${c_orange}" "${NODE_LTS_MAJOR}" "${c_reset}" "${NODE_LTS_MAJOR}"
    fi
  fi
  printf "  1. %sforeman init%s        one-time setup of Foreman's home (identity, policy, db)\n" "${c_orange}" "${c_reset}"
  printf "  2. %sforeman setup%s       5-minute wizard: API keys, agents, MCP config, policy\n" "${c_orange}" "${c_reset}"
  printf "  3. %sforeman start%s       boot the TUI\n" "${c_orange}" "${c_reset}"
  printf "\n%sREADME: https://github.com/%s%s\n" "${c_dim}" "${REPO}" "${c_reset}"
  printf "%sRun 'foreman doctor' to see the platform-native paths Foreman uses.%s\n" "${c_dim}" "${c_reset}"
}

# The directory holding the foreman binary: FOREMAN_INSTALL_PREFIX, on
# PATH, else under any nvm Node (the shell may default to another one).
locate_foreman_bin_dir() {
  if [ -n "${FOREMAN_INSTALL_PREFIX:-}" ] && [ -x "${FOREMAN_INSTALL_PREFIX}/bin/foreman" ]; then
    printf "%s\n" "${FOREMAN_INSTALL_PREFIX}/bin"
    return 0
  fi
  if command -v foreman >/dev/null 2>&1; then
    dirname "$(command -v foreman)"
    return 0
  fi
  local dir
  for dir in "${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin; do
    if [ -x "${dir}/foreman" ]; then
      printf "%s\n" "${dir}"
      return 0
    fi
  done
  return 1
}

# Foreman's data directories (resolveDirs in src/utils/config.ts).
foreman_data_dirs() {
  if [ -n "${FOREMAN_HOME:-}" ]; then
    printf "%s\n" "${FOREMAN_HOME}"
  elif [ "$(uname -s)" = "Darwin" ]; then
    printf "%s\n" "$HOME/Library/Application Support/foreman" "$HOME/Library/Caches/foreman"
  else
    printf "%s\n" "${XDG_CONFIG_HOME:-$HOME/.config}/foreman" "${XDG_STATE_HOME:-$HOME/.local/state}/foreman" "${XDG_CACHE_HOME:-$HOME/.cache}/foreman"
  fi
  if [ -d "$HOME/.foreman" ]; then
    printf "%s\n" "$HOME/.foreman"
  fi
  return 0
}

uninstall_foreman() {
  local purge="${1:-0}" bin_dir="" brew_install=0
  bin_dir=$(locate_foreman_bin_dir || true)
  if [ -n "${bin_dir}" ]; then
    # Foreman's own Node first, whatever the shell's default is.
    PATH="${bin_dir}:${PATH}"
    export PATH
    case "$(cd "${bin_dir}" && pwd -P)" in
      */Cellar/*|*/homebrew/*|*/linuxbrew/*) brew_install=1 ;;
    esac

    step "Taking Foreman out of your agents"
    if foreman service uninstall >/dev/null 2>&1; then
      ok "background service removed (if it was installed)"
    fi
    local ids id
    ids=$(foreman agent list --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{try{for(const a of JSON.parse(s))console.log(a.id)}catch{}})' || true)
    if [ -z "${ids}" ]; then
      ok "no agents registered"
    fi
    for id in ${ids}; do
      if foreman agent remove "${id}" --yes >/dev/null 2>&1; then
        ok "${id}: removed, with Foreman's MCP entry (and Claude Code hook) in its config"
      else
        warn "${id}: couldn't remove it; run 'foreman agent remove ${id} --yes' yourself"
      fi
    done
    # Claude Code's hook even when claude-code isn't a registered agent:
    # once the package is gone, a hook left behind blocks every tool call.
    if foreman agent hook uninstall claude-code >/dev/null 2>&1; then
      ok "Claude Code: Foreman's hook removed from its settings (if it was there)"
    else
      warn "Claude Code: couldn't remove Foreman's hook. Delete the \"foreman.pre-tool-use\" entry under hooks.PreToolUse in ~/.claude/settings.json, or Claude Code blocks every tool call"
    fi
    log "  ${c_dim}A hook added to one project (--project) stays: 'foreman agent hook uninstall claude-code --project <dir>' removes it.${c_reset}"
  else
    warn "foreman isn't installed here (not on PATH, not under nvm): nothing to take out of your agents"
    warn "If Claude Code blocks every tool call with \"Foreman's hook could not run\", delete Foreman's entry under hooks.PreToolUse in ~/.claude/settings.json"
  fi

  step "Removing ${PACKAGE}"
  if [ "${brew_install}" = "1" ]; then
    warn "This foreman came from Homebrew: run 'brew uninstall foreman-agent'"
  elif ! command -v npm >/dev/null 2>&1; then
    err "npm is not on PATH — cannot uninstall ${PACKAGE}"
  elif [ -n "${FOREMAN_INSTALL_PREFIX:-}" ]; then
    npm uninstall --prefix "${FOREMAN_INSTALL_PREFIX}" -g "${PACKAGE}" >/dev/null || warn "npm uninstall reported a non-zero exit"
    ok "${PACKAGE} removed"
  else
    npm uninstall -g "${PACKAGE}" >/dev/null || warn "npm uninstall reported a non-zero exit"
    ok "${PACKAGE} removed"
  fi

  step "Foreman's data"
  local dirs=() dir
  while IFS= read -r dir; do
    if [ -n "${dir}" ] && [ -e "${dir}" ]; then
      dirs+=("${dir}")
    fi
  done < <(foreman_data_dirs)
  if [ "${#dirs[@]}" -eq 0 ]; then
    ok "none found"
    return 0
  fi
  for dir in "${dirs[@]}"; do log "  ${dir}"; done
  if [ "${purge}" = "1" ] || ask "Delete it too (identity key, policy, audit log, stored secrets)? This can't be undone" n; then
    for dir in "${dirs[@]}"; do rm -rf -- "${dir}"; done
    ok "deleted"
  else
    ok "left in place (delete those folders yourself, or run again with --purge)"
  fi
}

main() {
  local uninstall=0 purge=0 arg
  for arg in "$@"; do
    case "${arg}" in
      --uninstall)  uninstall=1 ;;
      --purge)      purge=1 ;;
      --help|-h)    usage; exit 0 ;;
      *)            err "unknown flag: ${arg}"; usage; exit 1 ;;
    esac
  done
  if [ "${uninstall}" = "1" ]; then
    uninstall_foreman "${purge}"
    exit 0
  fi
  if [ "${purge}" = "1" ]; then
    err "--purge goes with --uninstall"
    exit 1
  fi

  printf "%sForeman installer%s\n" "${c_orange}${c_bold}" "${c_reset}"

  step "Checking Node"
  ensure_node
  npm_install_foreman
  verify_install
  check_default_node
  next_steps
}

# Tests load the functions without running the installer.
if [ "${FOREMAN_INSTALL_SOURCE_ONLY:-0}" != "1" ]; then
  main "$@"
fi
