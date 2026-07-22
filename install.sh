#!/usr/bin/env bash
# ┌──────────────────────────────────────────────────────────────┐
# │  Aether CLI — One-Command Installer                         │
# │                                                              │
# │  Usage: curl -fsSL https://aether-cli.dev/install.sh | bash  │
# │  Or:    bash install.sh                                      │
# └──────────────────────────────────────────────────────────────┘
#
# Detects your platform (Termux, Linux, macOS), installs dependencies,
# builds Aether CLI, and sets up the `aether` command.

set -euo pipefail

# ── Colors (guarded for non-TTY) ───────────────────────────────────────────

if [ -t 1 ]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  BLUE='\033[0;34m'
  CYAN='\033[0;36m'
  MAGENTA='\033[0;35m'
  BOLD='\033[1m'
  DIM='\033[2m'
  NC='\033[0m' # No Color
else
  RED='' GREEN='' YELLOW='' BLUE='' CYAN='' MAGENTA='' BOLD='' DIM='' NC=''
fi

# ── Banner ─────────────────────────────────────────────────────────────────

echo ""
echo -e "${CYAN}${BOLD}⚡ Aether CLI — Installer${NC}"
echo -e "${DIM}   Lightweight multi-model AI coding agent for your terminal${NC}"
echo ""

# ── Platform detection ─────────────────────────────────────────────────────

IS_TERMUX=false
IS_MACOS=false
IS_LINUX=false

if [ -n "${TERMUX_VERSION:-}" ] || [ -d /data/data/com.termux ]; then
  IS_TERMUX=true
elif [ "$(uname -s)" = "Darwin" ]; then
  IS_MACOS=true
elif [ "$(uname -s)" = "Linux" ]; then
  IS_LINUX=true
else
  echo -e "${RED}✗ Unsupported platform: $(uname -s)${NC}"
  echo "  Aether CLI supports Termux (Android), Linux, and macOS."
  exit 1
fi

if $IS_TERMUX; then
  echo -e "${GREEN}✓${NC} Detected: ${CYAN}Termux (Android)${NC}"
elif $IS_MACOS; then
  echo -e "${GREEN}✓${NC} Detected: ${CYAN}macOS${NC}"
else
  echo -e "${GREEN}✓${NC} Detected: ${CYAN}Linux${NC}"
fi

# ── Helper: print a step ───────────────────────────────────────────────────

step() {
  echo -e "${BLUE}→${NC} $1"
}

success() {
  echo -e "  ${GREEN}✓${NC} $1"
}

warn() {
  echo -e "  ${YELLOW}⚠${NC} $1"
}

fail() {
  echo -e "  ${RED}✗${NC} $1"
  exit 1
}

# ── Step 1: Check / install dependencies ───────────────────────────────────

echo ""
step "Checking dependencies..."

NEED_NODE=false
NEED_GIT=false

# Check for Bun first (preferred runtime)
if command -v bun &>/dev/null; then
  BUN_VERSION="$(bun --version 2>/dev/null || echo "unknown")"
  success "Bun found (v${BUN_VERSION})"
  RUNTIME="bun"
elif command -v node &>/dev/null; then
  NODE_VERSION="$(node --version 2>/dev/null || echo "unknown")"
  success "Node.js found (${NODE_VERSION})"
  RUNTIME="node"
else
  warn "Neither Bun nor Node.js found"
  NEED_NODE=true
fi

# Check for Git
if command -v git &>/dev/null; then
  GIT_VERSION="$(git --version 2>/dev/null | awk '{print $NF}' || echo "unknown")"
  success "Git found (v${GIT_VERSION})"
else
  warn "Git not found"
  NEED_GIT=true
fi

# Install missing dependencies
if $NEED_NODE || $NEED_GIT; then
  echo ""
  step "Installing missing dependencies..."

  if $IS_TERMUX; then
    if $NEED_NODE; then
      echo "  Installing Node.js via pkg..."
      pkg install -y nodejs || fail "Failed to install Node.js"
      success "Node.js installed"
    fi
    if $NEED_GIT; then
      echo "  Installing Git via pkg..."
      pkg install -y git || fail "Failed to install Git"
      success "Git installed"
    fi
    # In Termux, node is typically the safest bet; bun install is optional
    if [ "$RUNTIME" = "" ] || [ "$RUNTIME" = "node" ]; then
      RUNTIME="node"
    fi

  elif $IS_MACOS; then
    # Check for Homebrew
    if ! command -v brew &>/dev/null; then
      warn "Homebrew not found. Install it first: https://brew.sh"
      fail "Cannot auto-install dependencies without Homebrew"
    fi
    if $NEED_NODE; then
      echo "  Installing Node.js via Homebrew..."
      brew install node || fail "Failed to install Node.js"
      success "Node.js installed"
    fi
    if $NEED_GIT; then
      echo "  Installing Git via Homebrew..."
      brew install git || fail "Failed to install Git"
      success "Git installed"
    fi
    # On macOS, try bun for speed
    if command -v bun &>/dev/null; then
      RUNTIME="bun"
    else
      RUNTIME="node"
    fi

  elif $IS_LINUX; then
    if $NEED_NODE; then
      # Try common package managers
      if command -v apt-get &>/dev/null; then
        echo "  Installing Node.js via apt..."
        # Try nodesource first, fall back to distro packages
        if command -v curl &>/dev/null; then
          curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - 2>/dev/null || true
          sudo apt-get install -y nodejs 2>/dev/null || {
            warn "nodesource failed, trying distro packages"
            sudo apt-get update -qq && sudo apt-get install -y nodejs npm || fail "Failed to install Node.js"
          }
        else
          sudo apt-get update -qq && sudo apt-get install -y nodejs npm || fail "Failed to install Node.js"
        fi
        success "Node.js installed"
      elif command -v dnf &>/dev/null; then
        echo "  Installing Node.js via dnf..."
        sudo dnf install -y nodejs || fail "Failed to install Node.js"
        success "Node.js installed"
      elif command -v pacman &>/dev/null; then
        echo "  Installing Node.js via pacman..."
        sudo pacman -S --noconfirm nodejs npm || fail "Failed to install Node.js"
        success "Node.js installed"
      elif command -v apk &>/dev/null; then
        echo "  Installing Node.js via apk..."
        sudo apk add nodejs npm || fail "Failed to install Node.js"
        success "Node.js installed"
      else
        fail "Cannot detect package manager. Please install Node.js manually: https://nodejs.org"
      fi
    fi
    if $NEED_GIT; then
      if command -v apt-get &>/dev/null; then
        sudo apt-get install -y git || fail "Failed to install Git"
      elif command -v dnf &>/dev/null; then
        sudo dnf install -y git || fail "Failed to install Git"
      elif command -v pacman &>/dev/null; then
        sudo pacman -S --noconfirm git || fail "Failed to install Git"
      elif command -v apk &>/dev/null; then
        sudo apk add git || fail "Failed to install Git"
      else
        fail "Cannot install Git automatically. Please install it manually."
      fi
      success "Git installed"
    fi
    RUNTIME="node"
  fi
fi

# Verify we have a runtime
if [ "$RUNTIME" = "" ]; then
  if command -v node &>/dev/null; then
    RUNTIME="node"
  elif command -v bun &>/dev/null; then
    RUNTIME="bun"
  else
    fail "No JavaScript runtime found after dependency installation"
  fi
fi

# ── Step 2: Determine install location ─────────────────────────────────────

echo ""
step "Determining install location..."

if $IS_TERMUX; then
  INSTALL_DIR="${PREFIX:-/data/data/com.termux/files/usr}/opt/aether-cli"
  BIN_DIR="${PREFIX:-/data/data/com.termux/files/usr}/bin"
else
  INSTALL_DIR="${HOME}/.aether-cli"
  # Prefer /usr/local/bin if writable, otherwise ~/.local/bin
  if [ -w /usr/local/bin ]; then
    BIN_DIR="/usr/local/bin"
  else
    BIN_DIR="${HOME}/.local/bin"
    mkdir -p "$BIN_DIR"
  fi
fi

success "Install dir: ${INSTALL_DIR}"
success "Binary dir: ${BIN_DIR}"

# ── Step 3: Clone or update the repository ─────────────────────────────────

REPO_URL="${AETHER_REPO_URL:-https://github.com/aether-cli/aether-cli.git}"

if [ -d "$INSTALL_DIR/.git" ]; then
  echo ""
  step "Updating existing installation..."
  cd "$INSTALL_DIR"
  git pull --ff-only origin main 2>/dev/null || git pull --ff-only origin master 2>/dev/null || {
    warn "Could not fast-forward update. Re-cloning..."
    cd /
    rm -rf "$INSTALL_DIR"
    git clone --depth 1 "$REPO_URL" "$INSTALL_DIR" || fail "Failed to clone repository"
  }
  success "Repository updated"
else
  echo ""
  step "Cloning repository..."
  if [ -d "$INSTALL_DIR" ]; then
    warn "Directory exists but is not a git repo. Backing up..."
    mv "$INSTALL_DIR" "${INSTALL_DIR}.bak.$(date +%s)"
  fi
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR" || fail "Failed to clone repository"
  success "Repository cloned"
fi

cd "$INSTALL_DIR"

# ── Step 4: Install dependencies ───────────────────────────────────────────

echo ""
step "Installing Node dependencies..."

if [ "$RUNTIME" = "bun" ]; then
  bun install --frozen-lockfile 2>/dev/null || bun install || fail "bun install failed"
  success "Dependencies installed (Bun)"
else
  if command -v npm &>/dev/null; then
    npm install --production --no-audit --no-fund 2>/dev/null || npm install || fail "npm install failed"
    success "Dependencies installed (npm)"
  else
    fail "npm not found — cannot install dependencies"
  fi
fi

# ── Step 5: Install Bun for building (if not already) ──────────────────────

# Aether CLI is built with Bun's bundler. We need bun for the build step.
if ! command -v bun &>/dev/null; then
  echo ""
  step "Installing Bun (required for build)..."
  if $IS_TERMUX; then
    # In Termux, bun can be tricky — try npm-based approach
    warn "Bun is not officially supported on Termux/ARM."
    warn "Installing a Node-only fallback build..."

    # Create a simple launcher that uses tsx or ts-node
    if command -v npx &>/dev/null; then
      npx --yes tsx src/cli.ts --help &>/dev/null || warn "tsx not available, using pre-built dist"
    fi

    if [ ! -f "$INSTALL_DIR/dist/cli.js" ]; then
      fail "Pre-built dist/cli.js not found. Aether CLI requires a build step."
    fi
  else
    curl -fsSL https://bun.sh/install | bash || fail "Failed to install Bun"

    # Source bun into PATH
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"

    if ! command -v bun &>/dev/null; then
      # Try alternative path
      if [ -f "$HOME/.bun/bin/bun" ]; then
        export PATH="$HOME/.bun/bin:$PATH"
      fi
    fi

    if command -v bun &>/dev/null; then
      success "Bun installed"
    else
      fail "Bun installed but not found in PATH"
    fi
  fi
fi

# ── Step 6: Build ──────────────────────────────────────────────────────────

echo ""
step "Building Aether CLI..."

if command -v bun &>/dev/null; then
  bun run build || fail "Build failed"
  success "Build completed (Bun bundler)"
else
  # Try TypeScript compilation as fallback
  if command -v npx &>/dev/null; then
    npx --yes tsc --outDir dist 2>/dev/null || warn "TypeScript compilation not available"
  fi
  if [ ! -f "$INSTALL_DIR/dist/cli.js" ]; then
    fail "Build failed and no pre-built dist found"
  fi
  success "Using pre-built dist"
fi

# ── Step 7: Create symlink ─────────────────────────────────────────────────

echo ""
step "Creating symlink..."

# Ensure bin directory exists
mkdir -p "$BIN_DIR"

# Check if BIN_DIR is in PATH
if ! echo "$PATH" | tr ':' '\n' | grep -qxF "$BIN_DIR"; then
  warn "${BIN_DIR} is not in your PATH"
  echo "  Add this to your shell config (.bashrc, .zshrc, or .profile):"
  echo -e "  ${CYAN}export PATH=\"\$PATH:${BIN_DIR}\"${NC}"
fi

# Create symlink
SYMLINK_PATH="${BIN_DIR}/aether"
if [ -L "$SYMLINK_PATH" ]; then
  # Already exists — update if pointing elsewhere
  CURRENT_TARGET="$(readlink "$SYMLINK_PATH")"
  if [ "$CURRENT_TARGET" != "$INSTALL_DIR/bin/aether" ]; then
    rm "$SYMLINK_PATH"
    ln -s "$INSTALL_DIR/bin/aether" "$SYMLINK_PATH"
    success "Symlink updated: ${SYMLINK_PATH} → ${INSTALL_DIR}/bin/aether"
  else
    success "Symlink already exists: ${SYMLINK_PATH}"
  fi
elif [ -e "$SYMLINK_PATH" ]; then
  warn "A file already exists at ${SYMLINK_PATH}. Backing up..."
  mv "$SYMLINK_PATH" "${SYMLINK_PATH}.bak.$(date +%s)"
  ln -s "$INSTALL_DIR/bin/aether" "$SYMLINK_PATH"
  success "Symlink created (with backup): ${SYMLINK_PATH}"
else
  ln -s "$INSTALL_DIR/bin/aether" "$SYMLINK_PATH"
  success "Symlink created: ${SYMLINK_PATH} → ${INSTALL_DIR}/bin/aether"
fi

# ── Step 8: Shell completion ───────────────────────────────────────────────

echo ""
step "Setting up shell completion..."

# Detect shell
detect_shell() {
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

SHELL_NAME="$(detect_shell)"
COMPLETION_DIR=""

case "$SHELL_NAME" in
  zsh)
    if [ -d "${ZSH:-$HOME/.oh-my-zsh}" ]; then
      COMPLETION_DIR="${ZSH:-$HOME/.oh-my-zsh}/completions"
    else
      COMPLETION_DIR="${HOME}/.zsh/completion"
    fi
    ;;
  bash)
    if [ -d "${BASH_COMPLETION_USER_DIR:-}" ]; then
      COMPLETION_DIR="${BASH_COMPLETION_USER_DIR}"
    elif [ -d /etc/bash_completion.d ] && [ -w /etc/bash_completion.d ]; then
      COMPLETION_DIR="/etc/bash_completion.d"
    else
      COMPLETION_DIR="${HOME}/.bash_completion.d"
    fi
    ;;
  fish)
    COMPLETION_DIR="${HOME}/.config/fish/completions"
    ;;
esac

if [ -n "$COMPLETION_DIR" ]; then
  mkdir -p "$COMPLETION_DIR"

  # Generate a basic completion script for commander.js-style CLIs
  if [ "$SHELL_NAME" = "bash" ]; then
    cat > "${COMPLETION_DIR}/aether" <<'BASHCOMP'
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
      # File/path completion for remaining args
      _filedir
      ;;
  esac
}
complete -F _aether_completion aether
BASHCOMP
    success "Bash completion installed to ${COMPLETION_DIR}/aether"
  elif [ "$SHELL_NAME" = "zsh" ]; then
    cat > "${COMPLETION_DIR}/_aether" <<'ZSHCOMP'
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
    success "Zsh completion installed to ${COMPLETION_DIR}/_aether"
  elif [ "$SHELL_NAME" = "fish" ]; then
    cat > "${COMPLETION_DIR}/aether.fish" <<'FISHCOMP'
complete -c aether -f

# Subcommands
complete -c aether -n "__fish_use_subcommand" -a "generate" -d "Generate code from a prompt"
complete -c aether -n "__fish_use_subcommand" -a "review" -d "Review code for bugs and issues"
complete -c aether -n "__fish_use_subcommand" -a "test" -d "Generate and run tests"
complete -c aether -n "__fish_use_subcommand" -a "config" -d "View and manage configuration"
complete -c aether -n "__fish_use_subcommand" -a "setup" -d "Interactive setup wizard"
complete -c aether -n "__fish_use_subcommand" -a "env" -d "Show environment info"
complete -c aether -n "__fish_use_subcommand" -a "context" -d "Manage project context"
complete -c aether -n "__fish_use_subcommand" -a "providers" -d "List LLM providers"

# generate options
complete -c aether -n "__fish_seen_subcommand_from generate" -l provider -d "LLM provider" -x
complete -c aether -n "__fish_seen_subcommand_from generate" -l model -d "Model name" -x
complete -c aether -n "__fish_seen_subcommand_from generate" -l mode -d "Generation mode" -x -a "create edit auto"
complete -c aether -n "__fish_seen_subcommand_from generate" -l force -d "Overwrite files"
complete -c aether -n "__fish_seen_subcommand_from generate" -l target -d "Target directory" -r
complete -c aether -n "__fish_seen_subcommand_from generate" -l file -d "Read prompt from file" -r
complete -c aether -n "__fish_seen_subcommand_from generate" -l dry-run -d "Preview only"

# review options
complete -c aether -n "__fish_seen_subcommand_from review" -l provider -d "LLM provider" -x
complete -c aether -n "__fish_seen_subcommand_from review" -l model -d "Model name" -x
complete -c aether -n "__fish_seen_subcommand_from review" -l json -d "Output as JSON"
complete -c aether -n "__fish_seen_subcommand_from review" -l apply -d "Auto-apply fixes"
complete -c aether -n "__fish_seen_subcommand_from review" -l severity -d "Filter by severity" -x -a "error warning info"
complete -c aether -n "__fish_seen_subcommand_from review" -l dry-run -d "Preview only"
FISHCOMP
    success "Fish completion installed to ${COMPLETION_DIR}/aether.fish"
  fi
else
  warn "Could not detect shell for completion setup"
fi

# ── Step 9: Verify installation ────────────────────────────────────────────

echo ""
step "Verifying installation..."

if [ -x "$SYMLINK_PATH" ] || [ -L "$SYMLINK_PATH" ]; then
  # Try to run --help
  if "$INSTALL_DIR/bin/aether" --help &>/dev/null 2>&1 || node "$INSTALL_DIR/dist/cli.js" --help &>/dev/null 2>&1 || bun run "$INSTALL_DIR/dist/cli.js" --help &>/dev/null 2>&1; then
    success "Aether CLI is working!"
  else
    # Try a direct run for debugging
    echo ""
    warn "Symlink works but CLI may need a runtime. Testing directly..."
    if node "$INSTALL_DIR/dist/cli.js" --version 2>/dev/null; then
      success "CLI works with Node.js"
    elif bun run "$INSTALL_DIR/dist/cli.js" --version 2>/dev/null; then
      success "CLI works with Bun"
    else
      warn "CLI not responding — this may be normal if no runtime is available in this shell"
    fi
  fi
else
  warn "Symlink not executable — check permissions"
fi

# ── Done ───────────────────────────────────────────────────────────────────

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

# Show PATH warning if needed
if ! echo "$PATH" | tr ':' '\n' | grep -qxF "$BIN_DIR"; then
  echo -e "  ${YELLOW}⚠  Important:${NC} Add ${BIN_DIR} to your PATH:"
  echo -e "    ${CYAN}echo 'export PATH=\"\$PATH:${BIN_DIR}\"' >> ~/.bashrc${NC}"
  echo -e "    ${CYAN}source ~/.bashrc${NC}"
  echo ""
fi

if $IS_TERMUX; then
  echo -e "  ${MAGENTA}💡 Termux tip:${NC} For offline use, try Ollama:"
  echo -e "    ${CYAN}pkg install ollama && ollama serve${NC}"
  echo -e "    ${CYAN}ollama pull codellama${NC}"
  echo -e "    ${CYAN}aether setup${NC}  (select Ollama when prompted)"
  echo ""
fi
