#!/usr/bin/env bash

set -euo pipefail

REPO="tuzlu07x/foreman"
PACKAGE="foreman-agent"
MIN_NODE_MAJOR=20
NVM_VERSION="${FOREMAN_NVM_VERSION:-v0.40.1}"
BINARY_FALLBACK_DIR="${FOREMAN_BINARY_DIR:-/usr/local/bin}"

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
  FOREMAN_USE_BINARY        set to 1 to download the standalone binary instead
                            of bootstrapping Node + npm (no Node required)
  FOREMAN_BINARY_DIR        target directory for the binary (default: /usr/local/bin)
EOF
}

current_node_major() {
  if ! command -v node >/dev/null 2>&1; then
    echo 0
    return
  fi
  node --version 2>/dev/null | sed -e 's/^v//' -e 's/\..*$//' || echo 0
}

ensure_node() {
  local major
  major=$(current_node_major)
  if [ "${major:-0}" -ge "${MIN_NODE_MAJOR}" ]; then
    ok "Node $(node --version) detected — reusing it"
    return 0
  fi

  if [ "${FOREMAN_SKIP_NVM:-0}" = "1" ]; then
    err "Node ${MIN_NODE_MAJOR}+ required but not found, and FOREMAN_SKIP_NVM=1"
    err "Install Node ${MIN_NODE_MAJOR} (https://nodejs.org) then re-run the installer."
    exit 1
  fi

  warn "Node ${MIN_NODE_MAJOR}+ not detected — bootstrapping via nvm"
  bootstrap_nvm

  # Load nvm into the current shell and install the LTS line.
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ ! -s "${NVM_DIR}/nvm.sh" ]; then
    err "nvm install completed but ${NVM_DIR}/nvm.sh is missing"
    err "Open a new shell and re-run this installer, or install Node manually."
    exit 1
  fi
  # shellcheck disable=SC1091
  . "${NVM_DIR}/nvm.sh"

  nvm install "${MIN_NODE_MAJOR}" >&2
  nvm use "${MIN_NODE_MAJOR}" >&2
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
  trap 'rm -f "${installer}"' RETURN
  if ! curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh" -o "${installer}"; then
    err "failed to download nvm ${NVM_VERSION} installer"
    err "manual: see https://github.com/nvm-sh/nvm#installing-and-updating"
    exit 1
  fi
  bash "${installer}"
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

detect_target() {
  local os arch
  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  arch=$(uname -m)
  case "${arch}" in
    arm64|aarch64) arch="arm64";;
    x86_64|amd64)  arch="x64";;
    *) err "unsupported architecture: ${arch}"; return 1;;
  esac
  case "${os}" in
    darwin) echo "darwin-${arch}";;
    linux)  echo "linux-${arch}";;
    *) err "unsupported os: ${os}"; return 1;;
  esac
}

install_binary() {
  local target version url tmp dest
  target=$(detect_target) || exit 1
  version="${FOREMAN_VERSION:-latest}"
  if [ "${version}" = "latest" ]; then
    if ! command -v curl >/dev/null 2>&1; then
      err "curl is required to discover the latest release"
      exit 1
    fi
    version=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
      | grep -E '"tag_name":' | head -1 | sed -E 's/.*"v?([^"]+)".*/\1/') \
      || { err "failed to discover latest version"; exit 1; }
  fi
  url="https://github.com/${REPO}/releases/download/v${version}/foreman-${target}"
  step "Downloading foreman ${version} for ${target}"
  tmp=$(mktemp -t foreman-XXXXXX)
  if ! curl -fsSL "${url}" -o "${tmp}"; then
    err "download failed: ${url}"
    err "Try a different FOREMAN_VERSION or fall back to: curl ... | bash  (without FOREMAN_USE_BINARY)"
    rm -f "${tmp}"
    exit 1
  fi
  chmod +x "${tmp}"
  mkdir -p "${BINARY_FALLBACK_DIR}"
  dest="${BINARY_FALLBACK_DIR}/foreman"
  if mv "${tmp}" "${dest}" 2>/dev/null; then
    ok "installed to ${dest}"
  elif sudo mv "${tmp}" "${dest}" 2>/dev/null; then
    ok "installed to ${dest} (with sudo)"
  else
    err "failed to move binary to ${dest} — set FOREMAN_BINARY_DIR to a writable dir"
    rm -f "${tmp}"
    exit 1
  fi
}

main() {
  case "${1:-}" in
    --uninstall)  uninstall_foreman; exit 0;;
    --help|-h)    usage; exit 0;;
    "")           ;;
    *)            err "unknown flag: $1"; usage; exit 1;;
  esac

  printf "%sForeman installer%s\n" "${c_orange}${c_bold}" "${c_reset}"

  if [ "${FOREMAN_USE_BINARY:-0}" = "1" ]; then
    install_binary
    verify_install
    next_steps
    return
  fi

  step "Checking Node"
  ensure_node
  npm_install_foreman
  verify_install
  next_steps
}

main "${1:-}"
