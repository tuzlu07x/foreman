#!/usr/bin/env bash

set -euo pipefail

REPO="tuzlu07x/foreman"
PACKAGE="foreman-agent"
MIN_NODE_MAJOR=20
NODE_LTS_MAJOR=20
SUPPORTED_NODE_MAJORS="20, 22"
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
  --uninstall     Remove the global ${PACKAGE} package (leaves Foreman's home directory intact)
  --help, -h      Show this help

${c_bold}ENVIRONMENT${c_reset}
  FOREMAN_INSTALL_PREFIX    npm prefix override
  FOREMAN_VERSION           specific version (default: latest published)
  FOREMAN_SKIP_NVM          set to 1 to refuse the nvm bootstrap path
  FOREMAN_REUSE_ANY_NODE    set to 1 to reuse a Node >=20 outside the tested
                            LTS lines (${SUPPORTED_NODE_MAJORS}); may require a C/C++ toolchain
EOF
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
    20|22) return 0 ;;
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

  if [ "${major:-0}" -ge "${MIN_NODE_MAJOR}" ]; then
    warn "Node $(node --version) has no prebuilt native binaries — installing Node ${NODE_LTS_MAJOR} LTS via nvm so you don't need a compiler"
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
  nvm install "${NODE_LTS_MAJOR}" >&2
  nvm use "${NODE_LTS_MAJOR}" >&2
  set -u
  ok "Node $(node --version) ready via nvm"
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
  printf "  1. %sforeman init%s        one-time setup of Foreman's home (identity, policy, db)\n" "${c_orange}" "${c_reset}"
  printf "  2. %sforeman setup%s       5-minute wizard: API keys, agents, MCP config, policy\n" "${c_orange}" "${c_reset}"
  printf "  3. %sforeman start%s       boot the TUI\n" "${c_orange}" "${c_reset}"
  printf "\n%sREADME: https://github.com/%s%s\n" "${c_dim}" "${REPO}" "${c_reset}"
  printf "%sRun 'foreman doctor' to see the platform-native paths Foreman uses.%s\n" "${c_dim}" "${c_reset}"
}

uninstall_foreman() {
  step "Removing global ${PACKAGE}"
  if ! command -v npm >/dev/null 2>&1; then
    err "npm is not on PATH — cannot uninstall via this script"
    exit 1
  fi
  if [ -n "${FOREMAN_INSTALL_PREFIX:-}" ]; then
    npm uninstall --prefix "${FOREMAN_INSTALL_PREFIX}" -g "${PACKAGE}" || warn "npm uninstall reported a non-zero exit"
  else
    npm uninstall -g "${PACKAGE}" || warn "npm uninstall reported a non-zero exit"
  fi
  ok "${PACKAGE} removed"
  printf "\n%sNote:%s your Foreman home (identity, policy, audit log) was NOT removed.\n" "${c_orange}" "${c_reset}"
  printf "Run %sforeman doctor%s before uninstalling to see its location, then remove it manually for a clean slate.\n" "${c_bold}" "${c_reset}"
}

main() {
  case "${1:-}" in
    --uninstall)  uninstall_foreman; exit 0;;
    --help|-h)    usage; exit 0;;
    "")           ;;
    *)            err "unknown flag: $1"; usage; exit 1;;
  esac

  printf "%sForeman installer%s\n" "${c_orange}${c_bold}" "${c_reset}"

  step "Checking Node"
  ensure_node
  npm_install_foreman
  verify_install
  next_steps
}

main "${1:-}"
