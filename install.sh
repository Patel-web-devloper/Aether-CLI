#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  Aether CLI — Installer                                                   ║
# ║                                                                             ║
# ║  Usage:                                                                     ║
# ║    curl -fsSL https://aether-cli.dev/install.sh | bash                      ║
# ║    bash install.sh [FLAGS]                                                  ║
# ║                                                                             ║
# ║  Modes:                                                                     ║
# ║    (default)   Fresh install                                                ║
# ║    --reinstall Re-clone and rebuild from scratch                            ║
# ║    --update    Git pull + rebuild if changed                                ║
# ║    --repair    Fix broken install (missing deps, corrupt cache, symlinks)   ║
# ║    --uninstall Remove everything cleanly                                    ║
# ║    --offline   Skip network operations, use cached data                     ║
# ║    --retry     Retry failed operations with backoff                         ║
# ║    --verbose   Detailed output                                              ║
# ║    --silent    Minimal output                                               ║
# ║    --quiet     Same as --silent                                             ║
# ║    --dry-run   Show what would happen                                       ║
# ║    --force     Skip confirmations                                           ║
# ║    --rollback  Revert to previous install on failure                        ║
# ║                                                                             ║
# ║  Environment variables:                                                     ║
# ║    AETHER_REPO_URL  Custom git repository URL                                ║
# ║    AETHER_BRANCH    Custom branch (default: main)                            ║
# ║    AETHER_TAG       Install specific tag                                    ║
# ║    AETHER_COMMIT    Install specific commit                                 ║
# ║    AETHER_DEBUG=1   Debug output                                            ║
# ║    AETHER_VERBOSE=1 Verbose output                                          ║
# ║    AETHER_NO_COLOR=1 No ANSI colors                                         ║
# ╚══════════════════════════════════════════════════════════════════════════════╝

set -euo pipefail

# ══════════════════════════════════════════════════════════════════════════════
#  SECTION 0: Globals, helpers, flags
# ══════════════════════════════════════════════════════════════════════════════

# ── Installer metadata ───────────────────────────────────────────────────────
readonly AETHER_VERSION="0.1.0"
readonly DEFAULT_REPO_URL="https://github.com/Patel-web-devloper/aether-cli.git"
readonly DEFAULT_BRANCH="main"
readonly BACKUP_KEEP=3
readonly START_TIME="$(date +%s)"

# ── Flags (parsed later, defaults) ───────────────────────────────────────────
MODE="install"        # install | reinstall | update | repair | uninstall
FLAG_OFFLINE=false
FLAG_RETRY=false
FLAG_VERBOSE=false
FLAG_SILENT=false
FLAG_DRY_RUN=false
FLAG_FORCE=false
FLAG_ROLLBACK=false

# ── Color helpers ────────────────────────────────────────────────────────────

setup_colors() {
  if [ -t 1 ] && [ "${AETHER_NO_COLOR:-0}" != "1" ] && [ "${NO_COLOR:-0}" != "1" ]; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    BLUE='\033[0;34m'
    CYAN='\033[0;36m'
    MAGENTA='\033[0;35m'
    BOLD='\033[1m'
    DIM='\033[2m'
    NC='\033[0m'
  else
    RED='' GREEN='' YELLOW='' BLUE='' CYAN='' MAGENTA='' BOLD='' DIM='' NC=''
  fi
}
setup_colors

# ── Logging ──────────────────────────────────────────────────────────────────

LOG_FILE=""
LOG_SECTION=""

init_logging() {
  LOG_FILE="${INSTALL_DIR:-${HOME}/.aether-cli}/install.log"
  # Ensure the directory exists
  if [ "$FLAG_DRY_RUN" != "true" ]; then
    mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
  fi
}

log_line() {
  if [ "$FLAG_DRY_RUN" = "true" ]; then return; fi
  if [ -n "$LOG_FILE" ]; then
    mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"
  fi
}

log_header() {
  LOG_SECTION="$1"
  log_line "── $1 ──"
}

log_value() {
  log_line "  $1: $2"
}

# ── Output helpers ───────────────────────────────────────────────────────────

step() {
  if [ "$FLAG_SILENT" != "true" ]; then
    echo -e "${BLUE}→${NC} $1"
  fi
  log_line "STEP: $1"
}

success() {
  if [ "$FLAG_SILENT" != "true" ]; then
    echo -e "  ${GREEN}✓${NC} $1"
  fi
  log_line "  OK: $1"
}

warn() {
  if [ "$FLAG_SILENT" != "true" ]; then
    echo -e "  ${YELLOW}⚠${NC} $1" >&2
  fi
  log_line "  WARN: $1"
}

fail() {
  local msg="$1"
  echo -e "  ${RED}✗${NC} ${msg}" >&2
  log_line "  FAIL: $msg"
  rollback_on_failure
  write_log_summary "failure" "$msg"
  exit 1
}

info() {
  if [ "$FLAG_SILENT" != "true" ] && [ "$FLAG_VERBOSE" = "true" ]; then
    echo -e "  ${DIM}ℹ${NC} $1"
  fi
  log_line "  INFO: $1"
}

debug_log() {
  if [ "${AETHER_DEBUG:-0}" = "1" ]; then
    echo -e "  ${DIM}[debug]${NC} $1" >&2
  fi
  log_line "  DEBUG: $1"
}

# ── Dry-run wrapper ──────────────────────────────────────────────────────────

dry_exec() {
  if [ "$FLAG_DRY_RUN" = "true" ]; then
    echo -e "  ${DIM}[dry-run]${NC} $*"
    return 0
  fi
  "$@"
}

# ── Retry logic ──────────────────────────────────────────────────────────────

retry() {
  local max_attempts=3
  local attempt=1
  local delays=(1 3 7)

  while [ $attempt -le $max_attempts ]; do
    if [ "$FLAG_DRY_RUN" = "true" ]; then
      echo -e "  ${DIM}[dry-run]${NC} $* (attempt $attempt/$max_attempts)"
      return 0
    fi

    if "$@"; then
      return 0
    fi

    local exit_code=$?
    if [ $attempt -lt $max_attempts ]; then
      local delay="${delays[$((attempt-1))]}"
      warn "Command failed (attempt $attempt/$max_attempts, exit=$exit_code). Retrying in ${delay}s..."
      log_line "  RETRY: attempt $attempt failed (exit=$exit_code), waiting ${delay}s"
      sleep "$delay"
    fi
    attempt=$((attempt + 1))
  done

  return $exit_code
}

# ── Confirmation prompt ──────────────────────────────────────────────────────

confirm() {
  local prompt="$1"
  if [ "$FLAG_FORCE" = "true" ]; then
    return 0
  fi
  if [ "$FLAG_SILENT" = "true" ]; then
    return 0
  fi
  echo -ne "${YELLOW}?${NC} $prompt [y/N] "
  read -r response
  case "$response" in
    [yY]|[yY][eE][sS]) return 0 ;;
    *) return 1 ;;
  esac
}

# ── Platform detection ───────────────────────────────────────────────────────

detect_platform() {
  local os
  os="$(uname -s)"
  local arch
  arch="$(uname -m)"

  # Termux
  if [ -n "${TERMUX_VERSION:-}" ] || [ -d /data/data/com.termux ]; then
    echo "termux"
    return
  fi

  # PRoot
  if [ -n "${PROOT_TMP_DIR:-}" ] || [ -n "${PROOT_RAW_BIND:-}" ]; then
    echo "proot"
    return
  fi
  if [ -e /proc/ish ] 2>/dev/null; then
    echo "proot"
    return
  fi
  if [ -L /proc/1/root ] 2>/dev/null; then
    local root_target
    root_target="$(readlink /proc/1/root 2>/dev/null || true)"
    if [ -n "$root_target" ] && [ "$root_target" != "/" ]; then
      echo "proot"
      return
    fi
  fi

  # WSL
  if [ -f /proc/sys/fs/binfmt_misc/WSLInterop ] 2>/dev/null; then
    echo "wsl"
    return
  fi
  if grep -qi microsoft /proc/version 2>/dev/null; then
    echo "wsl"
    return
  fi

  # Standard
  case "$os" in
    Darwin) echo "macos" ;;
    Linux)
      if [ -f /etc/os-release ]; then
        local id
        id="$(. /etc/os-release && echo "${ID:-}" | tr '[:upper:]' '[:lower:]')"
        case "$id" in
          ubuntu|debian|kali|arch|fedora|alpine|centos|rhel|opensuse*|manjaro|pop|mint|elementary|zorin|parrot|tails) echo "$id" ;;
          *) echo "linux" ;;
        esac
      elif [ -f /etc/alpine-release ]; then
        echo "alpine"
      elif [ -f /etc/arch-release ]; then
        echo "arch"
      else
        echo "linux"
      fi
      ;;
    *) echo "$os" ;;
  esac
}

detect_arch() {
  local arch
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64)  echo "x64" ;;
    aarch64|arm64) echo "arm64" ;;
    armv7l|armv8l) echo "arm" ;;
    *)             echo "$arch" ;;
  esac
}

detect_package_manager() {
  if [ "$PLATFORM" = "termux" ]; then
    echo "pkg"
  elif [ "$PLATFORM" = "macos" ]; then
    if command -v brew >/dev/null 2>&1; then echo "brew"; else echo "none"; fi
  elif [ "$PLATFORM" = "alpine" ]; then
    echo "apk"
  elif command -v apt-get >/dev/null 2>&1; then
    echo "apt"
  elif command -v dnf >/dev/null 2>&1; then
    echo "dnf"
  elif command -v yum >/dev/null 2>&1; then
    echo "yum"
  elif command -v pacman >/dev/null 2>&1; then
    echo "pacman"
  elif command -v apk >/dev/null 2>&1; then
    echo "apk"
  else
    echo "none"
  fi
}

PLATFORM="$(detect_platform)"
ARCH="$(detect_arch)"
PKG_MGR="$(detect_package_manager)"

# ── Termux/PRoot helpers ─────────────────────────────────────────────────────

is_termux_env() {
  case "$PLATFORM" in
    termux|proot) return 0 ;;
    *) return 1 ;;
  esac
}

is_proot_env() {
  [ "$PLATFORM" = "proot" ]
}

# ── Shell detection ──────────────────────────────────────────────────────────

detect_shell_name() {
  if [ -n "${ZSH_VERSION:-}" ]; then
    echo "zsh"
  elif [ -n "${BASH_VERSION:-}" ]; then
    echo "bash"
  elif [ -n "${FISH_VERSION:-}" ]; then
    echo "fish"
  elif [ -n "${SHELL:-}" ]; then
    basename "$SHELL"
  else
    echo "unknown"
  fi
}

detect_shell_rc() {
  case "$1" in
    zsh)  echo "${HOME}/.zshrc" ;;
    bash) echo "${HOME}/.bashrc" ;;
    fish) echo "${HOME}/.config/fish/config.fish" ;;
    *)    echo "${HOME}/.profile" ;;
  esac
}

# ── Install sudo detection ───────────────────────────────────────────────────

use_sudo() {
  if [ "$(id -u)" -eq 0 ]; then
    # Already root, no sudo needed
    echo ""
  elif [ "$PLATFORM" = "termux" ] || [ "$PLATFORM" = "proot" ]; then
    # Termux typically doesn't have or need sudo
    echo ""
  elif command -v sudo >/dev/null 2>&1; then
    echo "sudo"
  else
    echo ""
  fi
}

SUDO="$(use_sudo)"

# ── Flag parsing ─────────────────────────────────────────────────────────────

parse_flags() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --reinstall) MODE="reinstall" ;;
      --update)    MODE="update" ;;
      --repair)    MODE="repair" ;;
      --uninstall) MODE="uninstall" ;;
      --offline)   FLAG_OFFLINE=true ;;
      --retry)     FLAG_RETRY=true ;;
      --verbose)   FLAG_VERBOSE=true ;;
      --silent|--quiet) FLAG_SILENT=true ;;
      --dry-run)   FLAG_DRY_RUN=true ;;
      --force)     FLAG_FORCE=true ;;
      --rollback)  FLAG_ROLLBACK=true ;;
      --help|-h)
        echo "Usage: bash install.sh [FLAGS]"
        echo ""
        echo "Modes:"
        echo "  (default)    Fresh install"
        echo "  --reinstall  Re-clone and rebuild"
        echo "  --update     Git pull + rebuild if changed"
        echo "  --repair     Fix broken install"
        echo "  --uninstall  Remove everything"
        echo ""
        echo "Flags:"
        echo "  --offline    Skip network operations"
        echo "  --retry      Retry failed operations with backoff"
        echo "  --verbose    Detailed output"
        echo "  --silent     Minimal output"
        echo "  --dry-run    Show what would happen"
        echo "  --force      Skip confirmations"
        echo "  --rollback   Revert on failure"
        echo "  --help       Show this help"
        echo ""
        echo "Environment variables:"
        echo "  AETHER_REPO_URL  Custom git repository URL"
        echo "  AETHER_BRANCH    Custom git branch"
        echo "  AETHER_TAG       Install specific tag"
        echo "  AETHER_COMMIT    Install specific commit"
        echo "  AETHER_DEBUG=1   Debug output"
        echo "  AETHER_VERBOSE=1 Verbose output"
        echo "  AETHER_NO_COLOR=1 No colors"
        exit 0
        ;;
      *)
        warn "Unknown flag: $1 (try --help)"
        exit 1
        ;;
    esac
    shift
  done

  # --retry implies retry behavior in functions
  # --verbose enables additional output
}

parse_flags "$@"

# If --silent, also suppress debug
if [ "$FLAG_SILENT" = "true" ]; then
  AETHER_DEBUG=0
fi

# ══════════════════════════════════════════════════════════════════════════════
#  SECTION 1: Backup & rollback
# ══════════════════════════════════════════════════════════════════════════════

backup_dir() {
  if [ "$FLAG_DRY_RUN" = "true" ]; then
    echo "${INSTALL_DIR}/backups/dry-run-$(date +%s)"
    return 0
  fi
  local ts
  ts="$(date +%Y%m%d-%H%M%S)"
  echo "${INSTALL_DIR}/backups/${ts}"
}

create_backup() {
  local backup_path
  backup_path="$(backup_dir)"
  log_line "Creating backup at $backup_path"

  if [ "$FLAG_DRY_RUN" = "true" ]; then
    echo -e "  ${DIM}[dry-run]${NC} Would create backup at $backup_path"
    return 0
  fi

  mkdir -p "$backup_path"

  # Backup bin/aether
  if [ -f "${INSTALL_DIR}/bin/aether" ]; then
    cp -a "${INSTALL_DIR}/bin/aether" "$backup_path/bin.aether" 2>/dev/null || true
  fi

  # Backup dist
  if [ -d "${INSTALL_DIR}/dist" ]; then
    cp -a "${INSTALL_DIR}/dist" "$backup_path/dist" 2>/dev/null || true
  fi

  # Backup node_modules (just note they existed)
  if [ -d "${INSTALL_DIR}/node_modules" ]; then
    touch "$backup_path/had_node_modules" 2>/dev/null || true
  fi

  # Backup package.json
  if [ -f "${INSTALL_DIR}/package.json" ]; then
    cp -a "${INSTALL_DIR}/package.json" "$backup_path/package.json" 2>/dev/null || true
  fi

  # Record current commit
  if [ -d "${INSTALL_DIR}/.git" ] && command -v git >/dev/null 2>&1; then
    (cd "${INSTALL_DIR}" && git rev-parse HEAD 2>/dev/null || true) > "$backup_path/git-rev" 2>/dev/null || true
  fi

  info "Backup created at $backup_path"
}

rotate_backups() {
  if [ "$FLAG_DRY_RUN" = "true" ]; then return 0; fi
  local backup_root="${INSTALL_DIR}/backups"
  if [ ! -d "$backup_root" ]; then return 0; fi

  # List backups by time, keep latest BACKUP_KEEP
  local count
  count="$(ls -1d "$backup_root"/*/ 2>/dev/null | wc -l)"
  if [ "$count" -gt "$BACKUP_KEEP" ]; then
    ls -1dt "$backup_root"/*/ 2>/dev/null | tail -n +$((BACKUP_KEEP + 1)) | while read -r d; do
      rm -rf "$d"
      info "Rotated old backup: $d"
    done
  fi
}

rollback_on_failure() {
  if [ "$FLAG_ROLLBACK" != "true" ]; then return 0; fi

  log_line "Rolling back..."
  if [ "$FLAG_SILENT" != "true" ]; then
    echo -e "${YELLOW}⟲${NC} Rolling back to previous state..." >&2
  fi

  local newest_backup
  newest_backup="$(ls -1dt "${INSTALL_DIR}/backups"/*/ 2>/dev/null | head -1 || true)"

  if [ -z "$newest_backup" ]; then
    warn "No backup found to roll back to"
    return 0
  fi

  if [ -f "${newest_backup}/bin.aether" ]; then
    cp -a "${newest_backup}/bin.aether" "${INSTALL_DIR}/bin/aether" 2>/dev/null || true
  fi

  if [ -d "${newest_backup}/dist" ]; then
    rm -rf "${INSTALL_DIR}/dist" 2>/dev/null || true
    cp -a "${newest_backup}/dist" "${INSTALL_DIR}/dist" 2>/dev/null || true
  fi

  if [ -f "${newest_backup}/package.json" ]; then
    cp -a "${newest_backup}/package.json" "${INSTALL_DIR}/package.json" 2>/dev/null || true
  fi

  success "Rolled back to backup: $(basename "$newest_backup")"
}

# ══════════════════════════════════════════════════════════════════════════════
#  SECTION 2: Dependency helpers
# ══════════════════════════════════════════════════════════════════════════════

install_package() {
  local pkg="$1"
  if [ "$FLAG_DRY_RUN" = "true" ]; then
    echo -e "  ${DIM}[dry-run]${NC} Would install: $pkg (via $PKG_MGR)"
    return 0
  fi

  case "$PKG_MGR" in
    pkg)
      pkg install -y "$pkg" ;;
    apt)
      $SUDO apt-get update -qq 2>/dev/null || true
      $SUDO apt-get install -y "$pkg" ;;
    dnf|yum)
      $SUDO "$PKG_MGR" install -y "$pkg" ;;
    pacman)
      $SUDO pacman -S --noconfirm "$pkg" ;;
    apk)
      $SUDO apk add "$pkg" ;;
    brew)
      brew install "$pkg" ;;
    *)
      return 1 ;;
  esac
}

ensure_runtime() {
  # Returns the best available runtime: "bun", "node", or "" if none
  if command -v bun >/dev/null 2>&1; then
    echo "bun"
  elif command -v node >/dev/null 2>&1; then
    echo "node"
  else
    echo ""
  fi
}

ensure_node() {
  if command -v node >/dev/null 2>&1; then
    return 0
  fi

  if [ "$FLAG_OFFLINE" = "true" ]; then
    fail "Node.js not found and --offline is set. Cannot install."
  fi

  step "Installing Node.js..."
  if [ "$PKG_MGR" = "none" ]; then
    fail "No package manager found. Please install Node.js manually: https://nodejs.org"
  fi

  if install_package "nodejs"; then
    success "Node.js installed"
    return 0
  fi

  # Try nodejs-lts or node as alternative names
  if install_package "node"; then
    success "Node.js installed"
    return 0
  fi

  fail "Failed to install Node.js. Please install it manually: https://nodejs.org"
}

ensure_git() {
  if command -v git >/dev/null 2>&1; then
    return 0
  fi

  if [ "$FLAG_OFFLINE" = "true" ]; then
    fail "Git not found and --offline is set. Cannot clone repository."
  fi

  step "Installing Git..."
  if install_package "git"; then
    success "Git installed"
    return 0
  fi
  fail "Failed to install Git. Please install it manually."
}

ensure_bun() {
  if command -v bun >/dev/null 2>&1; then
    return 0
  fi

  if [ "$FLAG_OFFLINE" = "true" ]; then
    warn "Bun not available offline — will use Node only"
    return 1
  fi

  # On Termux, bun is tricky and often fails
  if is_termux_env; then
    warn "Bun is not officially supported on Termux/ARM — using Node instead"
    return 1
  fi

  step "Installing Bun..."
  if curl -fsSL https://bun.sh/install | bash; then
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
    if command -v bun >/dev/null 2>&1; then
      success "Bun installed"
      return 0
    fi
    # Try alternative path
    if [ -f "$HOME/.bun/bin/bun" ]; then
      export PATH="$HOME/.bun/bin:$PATH"
      success "Bun installed"
      return 0
    fi
  fi

  warn "Bun installation failed — using Node instead"
  return 1
}

# ══════════════════════════════════════════════════════════════════════════════
#  SECTION 3: GitHub Releases-aware install
# ══════════════════════════════════════════════════════════════════════════════

get_release_platform_string() {
  local plat="$1"
  local arch="$2"
  case "$plat" in
    termux|proot)  echo "termux-${arch}" ;;
    macos)         echo "darwin-${arch}" ;;
    alpine)        echo "linux-musl-${arch}" ;;
    *)             echo "linux-${arch}" ;;
  esac
}

try_release_install() {
  if [ "$FLAG_OFFLINE" = "true" ]; then
    info "Skipping release check (offline mode)"
    return 1
  fi

  local release_plat
  release_plat="$(get_release_platform_string "$PLATFORM" "$ARCH")"
  local repo_url="${AETHER_REPO_URL:-$DEFAULT_REPO_URL}"

  # Parse owner/repo from URL
  local owner_repo
  owner_repo="$(echo "$repo_url" | sed -n 's|.*github\.com[:/]\([^/]*/[^/]*\)\.git|\1|p' | sed 's|/$||')"
  if [ -z "$owner_repo" ]; then
    info "Could not parse GitHub owner/repo from URL: $repo_url"
    return 1
  fi

  local api_url="https://api.github.com/repos/${owner_repo}/releases/latest"
  info "Checking releases: $api_url"

  local release_json
  release_json="$(curl -fsSL "$api_url" 2>/dev/null || true)"
  if [ -z "$release_json" ]; then
    info "No release info found — will build from source"
    return 1
  fi

  # Look for a matching asset
  local asset_url
  asset_url="$(echo "$release_json" | grep -o '"browser_download_url": *"[^"]*'"$release_plat"'[^"]*\.tar\.gz"' | head -1 | cut -d'"' -f4)"
  if [ -z "$asset_url" ]; then
    info "No release asset for $release_plat — will build from source"
    return 1
  fi

  step "Found release: ${asset_url}"

  if [ "$FLAG_DRY_RUN" = "true" ]; then
    echo -e "  ${DIM}[dry-run]${NC} Would download and extract $asset_url"
    return 0
  fi

  local tmpdir
  tmpdir="$(mktemp -d)"
  local tarball="$tmpdir/aether-cli.tar.gz"

  curl -fsSL -o "$tarball" "$asset_url" || {
    warn "Failed to download release — falling back to source install"
    rm -rf "$tmpdir"
    return 1
  }

  # Extract to install dir
  if [ -d "$INSTALL_DIR" ]; then
    create_backup
    rm -rf "${INSTALL_DIR}"/* 2>/dev/null || true
  fi
  mkdir -p "$INSTALL_DIR"

  tar xzf "$tarball" -C "$INSTALL_DIR" --strip-components=1 || {
    warn "Failed to extract release — falling back to source install"
    rm -rf "$tmpdir"
    return 1
  }

  rm -rf "$tmpdir"
  success "Release installed: $(basename "$asset_url")"
  return 0
}

# ══════════════════════════════════════════════════════════════════════════════
#  SECTION 4: Repository management
# ══════════════════════════════════════════════════════════════════════════════

resolve_refspec() {
  # Resolve the git refspec based on env vars: AETHER_TAG > AETHER_COMMIT > AETHER_BRANCH > default
  if [ -n "${AETHER_TAG:-}" ]; then
    echo "refs/tags/${AETHER_TAG}"
  elif [ -n "${AETHER_COMMIT:-}" ]; then
    echo "${AETHER_COMMIT}"
  elif [ -n "${AETHER_BRANCH:-}" ]; then
    echo "refs/heads/${AETHER_BRANCH}"
  else
    echo "refs/heads/${DEFAULT_BRANCH}"
  fi
}

resolve_refspec_name() {
  if [ -n "${AETHER_TAG:-}" ]; then
    echo "${AETHER_TAG}"
  elif [ -n "${AETHER_COMMIT:-}" ]; then
    echo "${AETHER_COMMIT}"
  elif [ -n "${AETHER_BRANCH:-}" ]; then
    echo "${AETHER_BRANCH}"
  else
    echo "${DEFAULT_BRANCH}"
  fi
}

clone_repo() {
  local repo_url="${AETHER_REPO_URL:-$DEFAULT_REPO_URL}"
  local refspec
  refspec="$(resolve_refspec)"

  step "Cloning repository..."
  info "URL: $repo_url"
  info "Ref:  $refspec"

  if [ "$FLAG_DRY_RUN" = "true" ]; then
    echo -e "  ${DIM}[dry-run]${NC} Would clone $repo_url to $INSTALL_DIR"
    return 0
  fi

  # Remove existing directory if it's not a git repo
  if [ -d "$INSTALL_DIR" ] && [ ! -d "${INSTALL_DIR}/.git" ]; then
    warn "Directory exists but is not a git repo. Backing up..."
    mv "$INSTALL_DIR" "${INSTALL_DIR}.bak.$(date +%s)"
  fi

  mkdir -p "$INSTALL_DIR"

  # Clone with full history if targeting a specific commit, otherwise shallow
  if [ -n "${AETHER_COMMIT:-}" ]; then
    git clone "$repo_url" "$INSTALL_DIR" || fail "Failed to clone repository"
  else
    git clone --depth 1 --branch "$(resolve_refspec_name)" "$repo_url" "$INSTALL_DIR" 2>/dev/null || {
      # Branch might not exist yet for shallow clone, try full clone
      git clone "$repo_url" "$INSTALL_DIR" || fail "Failed to clone repository"
    }
  fi

  # Checkout specific ref if needed
  if [ -n "${AETHER_TAG:-}" ] || [ -n "${AETHER_COMMIT:-}" ]; then
    (cd "$INSTALL_DIR" && git fetch --tags 2>/dev/null || true)
    if [ -n "${AETHER_TAG:-}" ]; then
      (cd "$INSTALL_DIR" && git checkout "tags/${AETHER_TAG}") || fail "Failed to checkout tag ${AETHER_TAG}"
    elif [ -n "${AETHER_COMMIT:-}" ]; then
      (cd "$INSTALL_DIR" && git checkout "${AETHER_COMMIT}") || fail "Failed to checkout commit ${AETHER_COMMIT}"
    fi
  fi

  success "Repository cloned"
}

update_repo() {
  local repo_url="${AETHER_REPO_URL:-$DEFAULT_REPO_URL}"

  if [ ! -d "${INSTALL_DIR}/.git" ]; then
    warn "Not a git repository — re-cloning..."
    clone_repo
    return
  fi

  step "Updating repository..."

  if [ "$FLAG_DRY_RUN" = "true" ]; then
    echo -e "  ${DIM}[dry-run]${NC} Would git pull in $INSTALL_DIR"
    return 0
  fi

  cd "$INSTALL_DIR"

  # Fetch updates
  if [ "$FLAG_OFFLINE" = "true" ]; then
    info "Skipping git fetch (offline mode)"
  else
    git fetch origin 2>/dev/null || warn "Could not fetch from remote"
  fi

  local refspec_name
  refspec_name="$(resolve_refspec_name)"

  # Check if we're at the right branch
  local current_branch
  current_branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "HEAD")"

  if [ "$current_branch" != "$refspec_name" ] && [ "$refspec_name" != "HEAD" ]; then
    git checkout "$refspec_name" 2>/dev/null || git checkout -b "$refspec_name" "origin/$refspec_name" 2>/dev/null || true
  fi

  # Try fast-forward
  if git pull --ff-only origin "$refspec_name" 2>/dev/null; then
    success "Repository updated"
  else
    warn "Could not fast-forward — re-cloning..."
    cd /
    rm -rf "$INSTALL_DIR"
    clone_repo
  fi

  cd "$INSTALL_DIR"
}

# ══════════════════════════════════════════════════════════════════════════════
#  SECTION 5: npm reliability
# ══════════════════════════════════════════════════════════════════════════════

npm_install() {
  step "Installing dependencies..."

  if [ "$FLAG_DRY_RUN" = "true" ]; then
    echo -e "  ${DIM}[dry-run]${NC} Would install dependencies"
    return 0
  fi

  cd "$INSTALL_DIR"

  if command -v bun >/dev/null 2>&1 && ! is_termux_env; then
    info "Using Bun for dependency installation"
    if retry bun install --frozen-lockfile 2>/dev/null; then
      success "Dependencies installed (Bun)"
      return 0
    fi
    warn "bun install --frozen-lockfile failed, trying without lockfile..."
    if retry bun install; then
      success "Dependencies installed (Bun, fallback)"
      return 0
    fi
    warn "Bun install failed, falling back to npm..."
  fi

  # npm path with retries and recovery
  if ! command -v npm >/dev/null 2>&1; then
    fail "npm not found — cannot install dependencies"
  fi

  # Attempt 1: normal
  if retry npm install --production --no-audit --no-fund 2>/dev/null; then
    success "Dependencies installed (npm)"
    return 0
  fi

  warn "npm install failed. Cleaning cache and retrying..."

  # Attempt 2: clean cache
  npm cache clean --force 2>/dev/null || true
  rm -rf node_modules 2>/dev/null || true
  if retry npm install 2>/dev/null; then
    success "Dependencies installed (npm, after cache clean)"
    return 0
  fi

  warn "npm install failed again. Removing node_modules and retrying..."

  # Attempt 3: nuclear — delete and reinstall
  rm -rf node_modules package-lock.json 2>/dev/null || true
  if retry npm install 2>/dev/null; then
    success "Dependencies installed (npm, after full reset)"
    return 0
  fi

  fail "npm install failed after multiple attempts. Check your network."
}

# ══════════════════════════════════════════════════════════════════════════════
#  SECTION 6: Build
# ══════════════════════════════════════════════════════════════════════════════

do_build() {
  step "Building Aether CLI..."

  if [ "$FLAG_DRY_RUN" = "true" ]; then
    echo -e "  ${DIM}[dry-run]${NC} Would build CLI"
    echo "bun" > "${INSTALL_DIR}/.build-backend" 2>/dev/null || true
    return 0
  fi

  cd "$INSTALL_DIR"

  if command -v bun >/dev/null 2>&1; then
    if bun run build 2>/dev/null; then
      echo "bun" > "${INSTALL_DIR}/.build-backend"
      success "Build completed (Bun bundler)"
      return 0
    fi
    warn "Bun build failed — trying alternatives..."
  fi

  # npm run build
  if command -v npm >/dev/null 2>&1 && npm run build 2>/dev/null; then
    echo "npm" > "${INSTALL_DIR}/.build-backend"
    success "Build completed (npm)"
    return 0
  fi

  # esbuild via npx
  if command -v npx >/dev/null 2>&1; then
    if npx --yes esbuild src/cli.ts --bundle --platform=node --format=esm --outfile=dist/cli.js 2>/dev/null; then
      echo "esbuild" > "${INSTALL_DIR}/.build-backend"
      success "Build completed (esbuild/npx)"
      return 0
    fi
  fi

  # tsc via npx
  if command -v npx >/dev/null 2>&1 && [ -f tsconfig.json ]; then
    if npx --yes tsc --outDir dist 2>/dev/null; then
      echo "tsc" > "${INSTALL_DIR}/.build-backend"
      success "Build completed (tsc/npx)"
      return 0
    fi
  fi

  fail "Build failed — all backends exhausted"
}

# ══════════════════════════════════════════════════════════════════════════════
#  SECTION 7: PATH handling and symlink
# ══════════════════════════════════════════════════════════════════════════════

add_to_path() {
  local bin_dir="$1"
  local shell_name
  shell_name="$(detect_shell_name)"
  local rc_file
  rc_file="$(detect_shell_rc "$shell_name")"

  # Check if already in PATH
  if echo "$PATH" | tr ':' '\n' | grep -qxF "$bin_dir"; then
    info "$bin_dir already in PATH"
    return 0
  fi

  # Check if already in RC file
  if [ -f "$rc_file" ]; then
    if grep -qF "$bin_dir" "$rc_file" 2>/dev/null; then
      info "$bin_dir already in $rc_file"
      return 0
    fi
  fi

  info "Adding $bin_dir to $rc_file"

  if [ "$FLAG_DRY_RUN" = "true" ]; then
    echo -e "  ${DIM}[dry-run]${NC} Would add PATH entry to $rc_file"
    return 0
  fi

  mkdir -p "$(dirname "$rc_file")" 2>/dev/null || true

  {
    echo ""
    echo "# Added by Aether CLI installer ($(date '+%Y-%m-%d'))"
    echo "export PATH=\"\$PATH:${bin_dir}\""
  } >> "$rc_file"

  # For fish, use fish_add_path instead
  if [ "$shell_name" = "fish" ]; then
    fish -c "fish_add_path $bin_dir" 2>/dev/null || true
  fi

  success "Added $bin_dir to PATH in $rc_file"
}

create_symlink() {
  local bin_dir="$1"
  local symlink_path="${bin_dir}/aether"

  step "Creating symlink..."

  if [ "$FLAG_DRY_RUN" = "true" ]; then
    echo -e "  ${DIM}[dry-run]${NC} Would create symlink $symlink_path → ${INSTALL_DIR}/bin/aether"
    return 0
  fi

  mkdir -p "$bin_dir"

  if [ -L "$symlink_path" ]; then
    local current
    current="$(readlink "$symlink_path")"
    if [ "$current" = "${INSTALL_DIR}/bin/aether" ]; then
      success "Symlink already correct: $symlink_path"
      return 0
    fi
    rm "$symlink_path"
  elif [ -e "$symlink_path" ]; then
    warn "File exists at $symlink_path — backing up..."
    mv "$symlink_path" "${symlink_path}.bak.$(date +%s)"
  fi

  ln -s "${INSTALL_DIR}/bin/aether" "$symlink_path"
  success "Symlink created: $symlink_path → ${INSTALL_DIR}/bin/aether"
}

# ══════════════════════════════════════════════════════════════════════════════
#  SECTION 8: Shell completion
# ══════════════════════════════════════════════════════════════════════════════

install_completions() {
  step "Setting up shell completion..."

  local shell_name
  shell_name="$(detect_shell_name)"
  local completion_dir=""

  case "$shell_name" in
    zsh)
      if [ -d "${ZSH:-$HOME/.oh-my-zsh}" ]; then
        completion_dir="${ZSH:-$HOME/.oh-my-zsh}/completions"
      else
        completion_dir="${HOME}/.zsh/completion"
      fi
      ;;
    bash)
      if [ -n "${BASH_COMPLETION_USER_DIR:-}" ]; then
        completion_dir="${BASH_COMPLETION_USER_DIR}"
      elif [ -d /etc/bash_completion.d ] && [ -w /etc/bash_completion.d ]; then
        completion_dir="/etc/bash_completion.d"
      else
        completion_dir="${HOME}/.bash_completion.d"
      fi
      ;;
    fish)
      completion_dir="${HOME}/.config/fish/completions"
      ;;
  esac

  if [ -z "$completion_dir" ]; then
    warn "Could not determine completion directory for shell: $shell_name"
    return 0
  fi

  if [ "$FLAG_DRY_RUN" = "true" ]; then
    echo -e "  ${DIM}[dry-run]${NC} Would install ${shell_name} completions to $completion_dir"
    return 0
  fi

  mkdir -p "$completion_dir"

  case "$shell_name" in
    bash)
      cat > "${completion_dir}/aether" <<'BASHCOMP'
_aether_completion() {
  local cur prev words cword
  _init_completion -s || return
  case $cword in
    1)
      COMPREPLY=($(compgen -W "generate review test config setup env context providers help" -- "$cur"))
      ;;
    2)
      case ${words[1]} in
        generate) COMPREPLY=($(compgen -W "--provider --model --mode --force --target --file --dry-run --help" -- "$cur")) ;;
        review)   COMPREPLY=($(compgen -W "--provider --model --json --apply --severity --dry-run --help" -- "$cur")) ;;
        test)     COMPREPLY=($(compgen -W "--provider --model --framework --coverage --watch --fix --dry-run --run --files --help" -- "$cur")) ;;
        config)   COMPREPLY=($(compgen -W "list get set reset --help" -- "$cur")) ;;
        context)  COMPREPLY=($(compgen -W "index stats history --help" -- "$cur")) ;;
        setup)    COMPREPLY=($(compgen -W "--check --help" -- "$cur")) ;;
      esac
      ;;
    *)
      _filedir
      ;;
  esac
}
complete -F _aether_completion aether
BASHCOMP
      success "Bash completion installed to ${completion_dir}/aether"
      ;;
    zsh)
      cat > "${completion_dir}/_aether" <<'ZSHCOMP'
#compdef aether
_aether() {
  local -a commands
  commands=(
    'generate:Generate code from a prompt'
    'review:Review code for bugs and issues'
    'test:Generate and run tests for code'
    'config:View and manage configuration'
    'setup:Interactive setup wizard'
    'env:Show environment info'
    'context:Manage project context'
    'providers:List LLM providers'
  )
  _arguments -C \
    '1: :->command' \
    '*::arg:->args'
  case $state in
    command)
      _describe 'command' commands
      ;;
    args)
      case $words[1] in
        generate)
          _arguments \
            '--provider[LLM provider]:provider:()' \
            '--model[Model name]:model:()' \
            '--mode[Mode: create, edit, auto]:mode:(create edit auto)' \
            '--force[Overwrite without prompt]' \
            '--target[Target directory]:dir:_files -/' \
            '--file[Read prompt from file]:file:_files' \
            '--dry-run[Preview only]' \
            '--help[Show help]'
          ;;
        review)
          _arguments \
            '--provider[LLM provider]:provider:()' \
            '--model[Model name]:model:()' \
            '--json[Output as JSON]' \
            '--apply[Auto-apply fixes]' \
            '--severity[Filter by severity]:severity:(error warning info)' \
            '--dry-run[Preview only]' \
            '--help[Show help]'
          ;;
        *)
          _files
          ;;
      esac
      ;;
  esac
}
ZSHCOMP
      success "Zsh completion installed to ${completion_dir}/_aether"
      ;;
    fish)
      cat > "${completion_dir}/aether.fish" <<'FISHCOMP'
complete -c aether -f
complete -c aether -n "__fish_use_subcommand" -a "generate" -d "Generate code from a prompt"
complete -c aether -n "__fish_use_subcommand" -a "review" -d "Review code for bugs and issues"
complete -c aether -n "__fish_use_subcommand" -a "test" -d "Generate and run tests"
complete -c aether -n "__fish_use_subcommand" -a "config" -d "View and manage configuration"
complete -c aether -n "__fish_use_subcommand" -a "setup" -d "Interactive setup wizard"
complete -c aether -n "__fish_use_subcommand" -a "env" -d "Show environment info"
complete -c aether -n "__fish_use_subcommand" -a "context" -d "Manage project context"
complete -c aether -n "__fish_use_subcommand" -a "providers" -d "List LLM providers"
complete -c aether -n "__fish_seen_subcommand_from generate" -l provider -d "LLM provider" -x
complete -c aether -n "__fish_seen_subcommand_from generate" -l model -d "Model name" -x
complete -c aether -n "__fish_seen_subcommand_from generate" -l mode -d "Generation mode" -x -a "create edit auto"
complete -c aether -n "__fish_seen_subcommand_from generate" -l force -d "Overwrite files"
complete -c aether -n "__fish_seen_subcommand_from generate" -l target -d "Target directory" -r
complete -c aether -n "__fish_seen_subcommand_from generate" -l file -d "Read prompt from file" -r
complete -c aether -n "__fish_seen_subcommand_from generate" -l dry-run -d "Preview only"
complete -c aether -n "__fish_seen_subcommand_from review" -l provider -d "LLM provider" -x
complete -c aether -n "__fish_seen_subcommand_from review" -l model -d "Model name" -x
complete -c aether -n "__fish_seen_subcommand_from review" -l json -d "Output as JSON"
complete -c aether -n "__fish_seen_subcommand_from review" -l apply -d "Auto-apply fixes"
complete -c aether -n "__fish_seen_subcommand_from review" -l severity -d "Filter by severity" -x -a "error warning info"
complete -c aether -n "__fish_seen_subcommand_from review" -l dry-run -d "Preview only"
FISHCOMP
      success "Fish completion installed to ${completion_dir}/aether.fish"
      ;;
  esac
}

# ══════════════════════════════════════════════════════════════════════════════
#  SECTION 9: Verify installation
# ══════════════════════════════════════════════════════════════════════════════

verify_install() {
  step "Verifying installation..."

  if [ "$FLAG_DRY_RUN" = "true" ]; then
    echo -e "  ${DIM}[dry-run]${NC} Would verify: ${INSTALL_DIR}/bin/aether --version"
    return 0
  fi

  # Test the launcher
  if [ -x "${INSTALL_DIR}/bin/aether" ] || [ -f "${INSTALL_DIR}/bin/aether" ]; then
    if "${INSTALL_DIR}/bin/aether" --version >/dev/null 2>&1; then
      local ver
      ver="$("${INSTALL_DIR}/bin/aether" --version 2>/dev/null || echo "unknown")"
      success "Aether CLI is working (version: $ver)"
    elif node "${INSTALL_DIR}/dist/cli.js" --version >/dev/null 2>&1; then
      success "Aether CLI is working (via Node)"
    elif bun run "${INSTALL_DIR}/dist/cli.js" --version >/dev/null 2>&1; then
      success "Aether CLI is working (via Bun)"
    else
      warn "CLI installed but not responding — check runtime availability"
    fi
  else
    warn "Launcher not found at ${INSTALL_DIR}/bin/aether"
  fi
}

# ══════════════════════════════════════════════════════════════════════════════
#  SECTION 10: Uninstall
# ══════════════════════════════════════════════════════════════════════════════

do_uninstall() {
  if [ "$FLAG_FORCE" != "true" ]; then
    if ! confirm "This will remove Aether CLI completely. Continue?"; then
      echo "Uninstall cancelled."
      exit 0
    fi
  fi

  step "Uninstalling Aether CLI..."

  if [ "$FLAG_DRY_RUN" = "true" ]; then
    echo -e "  ${DIM}[dry-run]${NC} Would remove:"
    echo -e "  ${DIM}[dry-run]${NC}   - $INSTALL_DIR"
    echo -e "  ${DIM}[dry-run]${NC}   - ${BIN_DIR}/aether symlink"
    echo -e "  ${DIM}[dry-run]${NC}   - Shell completions"
    echo -e "  ${DIM}[dry-run]${NC}   - PATH entries in shell configs"
    return 0
  fi

  # Remove symlink
  if [ -L "${BIN_DIR}/aether" ]; then
    rm "${BIN_DIR}/aether"
    success "Removed symlink: ${BIN_DIR}/aether"
  fi

  # Remove install directory
  if [ -d "$INSTALL_DIR" ]; then
    rm -rf "$INSTALL_DIR"
    success "Removed install directory: $INSTALL_DIR"
  fi

  # Remove shell completions
  local shell_name
  shell_name="$(detect_shell_name)"
  case "$shell_name" in
    bash)
      rm -f "${HOME}/.bash_completion.d/aether" 2>/dev/null || true
      rm -f "/etc/bash_completion.d/aether" 2>/dev/null || true
      ;;
    zsh)
      rm -f "${ZSH:-$HOME/.oh-my-zsh}/completions/_aether" 2>/dev/null || true
      rm -f "${HOME}/.zsh/completion/_aether" 2>/dev/null || true
      ;;
    fish)
      rm -f "${HOME}/.config/fish/completions/aether.fish" 2>/dev/null || true
      ;;
  esac
  success "Removed shell completions"

  # Remove PATH entries from RC files
  local rc_file
  rc_file="$(detect_shell_rc "$shell_name")"
  if [ -f "$rc_file" ]; then
    # Remove lines added by our installer (marked with the comment)
    if grep -q "# Added by Aether CLI installer" "$rc_file" 2>/dev/null; then
      # Create a backup first
      cp "$rc_file" "${rc_file}.bak.$(date +%s)"
      # Remove the Aether block
      sed -i '/^# Added by Aether CLI installer/,/^export PATH=.*aether/d' "$rc_file" 2>/dev/null || true
      # Also remove standalone PATH entries referencing aether
      sed -i '\|export PATH="\$PATH:.*aether|d' "$rc_file" 2>/dev/null || true
      success "Cleaned PATH entries from $rc_file"
    fi
  fi

  echo ""
  echo -e "${GREEN}${BOLD}✓ Aether CLI has been uninstalled.${NC}"
  echo ""

  write_log_summary "success" "uninstalled"
  exit 0
}

# ══════════════════════════════════════════════════════════════════════════════
#  SECTION 11: Repair mode
# ══════════════════════════════════════════════════════════════════════════════

do_repair() {
  step "Repairing Aether CLI installation..."

  if [ ! -d "$INSTALL_DIR" ]; then
    warn "Install directory not found — performing fresh install instead"
    MODE="install"
    return 0
  fi

  cd "$INSTALL_DIR" 2>/dev/null || fail "Cannot access $INSTALL_DIR"

  # Fix missing node_modules
  if [ ! -d "node_modules" ] || [ ! -f "node_modules/.package-lock.json" ] && [ ! -d "node_modules/commander" ]; then
    warn "node_modules appears corrupted or incomplete — reinstalling..."
    rm -rf node_modules 2>/dev/null || true
    if [ "$FLAG_OFFLINE" != "true" ]; then
      npm_install
    else
      warn "Offline mode — cannot repair node_modules"
    fi
  else
    success "node_modules looks OK"
  fi

  # Fix missing dist
  if [ ! -f "dist/cli.js" ]; then
    warn "dist/cli.js missing — rebuilding..."
    if [ "$FLAG_OFFLINE" != "true" ]; then
      do_build
    else
      warn "Offline mode — cannot rebuild"
    fi
  else
    success "dist/cli.js found"
  fi

  # Fix symlink
  if [ ! -L "${BIN_DIR}/aether" ]; then
    warn "Symlink missing — recreating..."
    create_symlink "$BIN_DIR"
  else
    local target
    target="$(readlink "${BIN_DIR}/aether")"
    if [ "$target" != "${INSTALL_DIR}/bin/aether" ]; then
      warn "Symlink points to wrong location — fixing..."
      rm "${BIN_DIR}/aether"
      create_symlink "$BIN_DIR"
    else
      success "Symlink is correct"
    fi
  fi

  # Fix broken .git
  if [ -d ".git" ] && ! git status >/dev/null 2>&1; then
    warn "Git repository is corrupted — re-cloning..."
    cd /
    rm -rf "$INSTALL_DIR"
    MODE="install"
    return 0
  fi

  # Fix corrupt npm cache
  if command -v npm >/dev/null 2>&1; then
    if [ "${AETHER_VERBOSE:-0}" = "1" ]; then
      npm cache verify 2>/dev/null || npm cache clean --force 2>/dev/null || true
    fi
  fi

  success "Repair complete"
}

# ══════════════════════════════════════════════════════════════════════════════
#  SECTION 12: Log summary
# ══════════════════════════════════════════════════════════════════════════════

write_log_summary() {
  local status="${1:-unknown}"
  local detail="${2:-}"

  local elapsed
  elapsed="$(($(date +%s) - START_TIME))"

  log_line "── INSTALL SUMMARY ──"
  log_value "status" "$status"
  log_value "detail" "$detail"
  log_value "platform" "$PLATFORM"
  log_value "architecture" "$ARCH"
  log_value "package_manager" "$PKG_MGR"
  log_value "runtime" "$(ensure_runtime || echo 'none')"
  log_value "node_version" "$(node --version 2>/dev/null || echo 'N/A')"
  log_value "bun_version" "$(bun --version 2>/dev/null || echo 'N/A')"
  log_value "install_dir" "$INSTALL_DIR"
  log_value "bin_dir" "$BIN_DIR"
  log_value "repo_url" "${AETHER_REPO_URL:-$DEFAULT_REPO_URL}"
  log_value "branch" "${AETHER_BRANCH:-$DEFAULT_BRANCH}"
  log_value "tag" "${AETHER_TAG:-N/A}"
  log_value "commit" "${AETHER_COMMIT:-N/A}"
  log_value "mode" "$MODE"
  log_value "build_backend" "$(cat "${INSTALL_DIR}/.build-backend" 2>/dev/null || echo 'unknown')"
  log_value "installed_version" "$AETHER_VERSION"
  log_value "elapsed_seconds" "$elapsed"
}

# ══════════════════════════════════════════════════════════════════════════════
#  SECTION 13: Banner and main
# ══════════════════════════════════════════════════════════════════════════════

show_banner() {
  if [ "$FLAG_SILENT" = "true" ]; then return 0; fi
  echo ""
  echo -e "${CYAN}${BOLD}⚡ Aether CLI — Installer${NC}"
  echo -e "${DIM}   Lightweight multi-model AI coding agent for your terminal${NC}"
  echo ""
}

show_success_banner() {
  if [ "$FLAG_SILENT" = "true" ]; then return 0; fi
  echo ""
  echo -e "${GREEN}${BOLD}╔══════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${GREEN}${BOLD}║  ✨ Aether CLI installed successfully!                      ║${NC}"
  echo -e "${GREEN}${BOLD}╚══════════════════════════════════════════════════════════════╝${NC}"
  echo ""
  echo -e "  ${BOLD}Run the setup wizard:${NC}"
  echo -e "    ${CYAN}aether setup${NC}"
  echo ""
  echo -e "  ${BOLD}Quick start:${NC}"
  echo -e "    ${CYAN}aether generate \"Hello world in TypeScript\" --dry-run${NC}"
  echo -e "    ${CYAN}aether env${NC}"
  echo -e "    ${CYAN}aether --help${NC}"
  echo ""

  if ! echo "$PATH" | tr ':' '\n' | grep -qxF "$BIN_DIR"; then
    echo -e "  ${YELLOW}⚠  Important:${NC} Add ${BIN_DIR} to your PATH:"
    echo -e "    ${CYAN}echo 'export PATH=\"\$PATH:${BIN_DIR}\"' >> ~/.bashrc${NC}"
    echo -e "    ${CYAN}source ~/.bashrc${NC}"
    echo ""
  fi

  if is_termux_env; then
    echo -e "  ${MAGENTA}💡 Termux tip:${NC} For offline use, try Ollama:"
    echo -e "    ${CYAN}pkg install ollama && ollama serve${NC}"
    echo -e "    ${CYAN}ollama pull codellama${NC}"
    echo -e "    ${CYAN}aether setup${NC}  (select Ollama when prompted)"
    echo ""
  fi
}

# ══════════════════════════════════════════════════════════════════════════════
#  SECTION 14: Main entry point
# ══════════════════════════════════════════════════════════════════════════════

main() {
  # ── Determine install locations ────────────────────────────────────────────
  if is_termux_env; then
    INSTALL_DIR="${PREFIX:-/data/data/com.termux/files/usr}/opt/aether-cli"
    BIN_DIR="${PREFIX:-/data/data/com.termux/files/usr}/bin"
  else
    INSTALL_DIR="${HOME}/.aether-cli"
    if [ -w /usr/local/bin ]; then
      BIN_DIR="/usr/local/bin"
    else
      BIN_DIR="${HOME}/.local/bin"
      mkdir -p "$BIN_DIR"
    fi
  fi

  init_logging
  show_banner

  # ── Platform info ──────────────────────────────────────────────────────────
  step "Platform: ${PLATFORM} (${ARCH})"
  success "Package manager: ${PKG_MGR}"
  info "Install directory: $INSTALL_DIR"
  info "Binary directory: $BIN_DIR"

  log_header "Installation start"
  log_value "mode" "$MODE"
  log_value "platform" "$PLATFORM"
  log_value "arch" "$ARCH"
  log_value "package_manager" "$PKG_MGR"

  # ── Mode: uninstall (short circuit) ────────────────────────────────────────
  if [ "$MODE" = "uninstall" ]; then
    do_uninstall
  fi

  # ── Mode: repair ───────────────────────────────────────────────────────────
  if [ "$MODE" = "repair" ]; then
    do_repair
    verify_install
    write_log_summary "success" "repaired"
    show_success_banner
    exit 0
  fi

  # ── Mode: reinstall ────────────────────────────────────────────────────────
  if [ "$MODE" = "reinstall" ]; then
    if [ "$FLAG_FORCE" != "true" ]; then
      if ! confirm "This will remove and reinstall Aether CLI. Continue?"; then
        echo "Reinstall cancelled."
        exit 0
      fi
    fi
    if [ -d "$INSTALL_DIR" ]; then
      create_backup
      rm -rf "$INSTALL_DIR"
      success "Removed previous installation"
    fi
    # Fall through to install
    MODE="install"
  fi

  # ── Mode: update ───────────────────────────────────────────────────────────
  if [ "$MODE" = "update" ]; then
    if [ ! -d "$INSTALL_DIR" ]; then
      warn "No existing installation found — performing fresh install"
      MODE="install"
    else
      create_backup
      update_repo
      if [ "$FLAG_OFFLINE" != "true" ]; then
        npm_install
        do_build
      fi
      rotate_backups
      install_completions
      verify_install
      write_log_summary "success" "updated"
      show_success_banner
      exit 0
    fi
  fi

  # ── Mode: install (default) ────────────────────────────────────────────────
  echo ""

  # Create backup before destructive operations
  if [ -d "$INSTALL_DIR" ] && [ "$MODE" != "update" ]; then
    create_backup
  fi

  # Try release install first (unless --offline)
  if try_release_install; then
    # Release install succeeded
    :
  else
    # Source install
    if [ "$FLAG_OFFLINE" != "true" ]; then
      ensure_git
    fi

    # Clone or update repo
    if [ ! -d "${INSTALL_DIR}/.git" ]; then
      if [ "$FLAG_OFFLINE" = "true" ]; then
        if [ -d "$INSTALL_DIR" ]; then
          warn "Offline mode — using existing directory"
        else
          fail "Install directory does not exist and --offline is set"
        fi
      else
        clone_repo
      fi
    fi

    if [ "$FLAG_DRY_RUN" = "true" ]; then
      mkdir -p "$INSTALL_DIR" 2>/dev/null || true
    fi
    cd "$INSTALL_DIR" || fail "Cannot access $INSTALL_DIR"

    # Install dependencies
    if [ "$FLAG_OFFLINE" != "true" ]; then
      ensure_node
      npm_install
    else
      if [ ! -d "node_modules" ]; then
        warn "node_modules missing and --offline is set — build may fail"
      fi
    fi
  fi

  # Build
  if [ ! -f "${INSTALL_DIR}/dist/cli.js" ]; then
    if [ "$FLAG_OFFLINE" != "true" ]; then
      ensure_bun || true
      do_build
    else
      if [ -f "${INSTALL_DIR}/dist/cli.js" ]; then
        success "Using prebuilt dist"
      else
        fail "dist/cli.js missing and --offline is set"
      fi
    fi
  else
    success "dist/cli.js found"
  fi

  # Symlink
  create_symlink "$BIN_DIR"

  # PATH
  add_to_path "$BIN_DIR"

  # Completions
  install_completions

  # Backup rotation
  rotate_backups

  # Verify
  verify_install

  # Done
  write_log_summary "success" "installed"
  show_success_banner
}

main "$@"
