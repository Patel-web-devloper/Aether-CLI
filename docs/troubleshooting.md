# Aether CLI — Troubleshooting

Common issues and their solutions when installing or using Aether CLI.

---

## Runtime Not Found

**Symptoms:**
```
Error: Neither Bun nor Node.js found.
```

**Solution:**

Install Node.js or Bun on your system:

**Termux (Android):**
```bash
pkg install nodejs
# Or install Bun:
curl -fsSL https://bun.sh/install | bash
```

**Linux:**
```bash
# Node.js via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | bash
apt-get install -y nodejs

# Or Bun:
curl -fsSL https://bun.sh/install | bash
```

**macOS:**
```bash
brew install node
# Or Bun:
curl -fsSL https://bun.sh/install | bash
```

---

## Permission Denied

**Symptoms:**
```
Permission denied: /usr/local/bin/aether
```
```
EACCES: permission denied
```

**Solution:**

1. **Make the launcher executable:**
   ```bash
   chmod +x ~/.aether-cli/bin/aether
   ```

2. **Use sudo for system-wide install:**
   ```bash
   sudo ln -s "$(pwd)/dist/cli.js" /usr/local/bin/aether
   ```

3. **Check ownership of config directories:**
   ```bash
   ls -la ~/.config/aether/
   ls -la ~/.local/share/aether/
   # Fix with:
   chown -R $USER:$USER ~/.config/aether ~/.local/share/aether
   ```

---

## Corrupted Install

**Symptoms:**
- `dist/cli.js` is missing or has errors
- `node_modules` is missing or incomplete
- Symlinks point to wrong locations

**Solution:**

Run the repair command:
```bash
aether repair
```

Or manually:
```bash
cd ~/.aether-cli
bun install
bun run build
```

If repair doesn't work, reinstall:
```bash
bash install.sh --reinstall
```

---

## API Key Issues

**Symptoms:**
```
Error: Missing API key for openai
```
```
Provider initialization failed: Unauthorized
```

**Solution:**

1. **Check which providers have keys configured:**
   ```bash
   aether env
   ```

2. **Set API keys as environment variables:**
   ```bash
   export OPENAI_API_KEY="sk-..."
   export ANTHROPIC_API_KEY="sk-ant-..."
   export GEMINI_API_KEY="..."
   export DEEPSEEK_API_KEY="..."
   export NVIDIA_API_KEY="..."
   export OPENROUTER_API_KEY="..."
   export GROQ_API_KEY="..."
   export TOGETHER_API_KEY="..."
   ```

3. **Use the setup wizard** (recommended):
   ```bash
   aether setup
   ```

4. **Add keys to your shell profile** for persistence:
   ```bash
   echo 'export OPENAI_API_KEY="sk-..."' >> ~/.bashrc
   source ~/.bashrc
   ```

5. **Verify key format:**
   - OpenAI keys start with `sk-`
   - Anthropic keys start with `sk-ant-`
   - Gemini keys are alphanumeric strings
   - If the key is truncated, re-copy it from the provider dashboard

---

## Network Issues

**Symptoms:**
```
Error: fetch failed
```
```
ETIMEDOUT
```
```
Could not check for updates — network or API issue
```

**Solution:**

1. **Check internet connectivity:**
   ```bash
   aether doctor
   ```

2. **If behind a proxy:**
   ```bash
   export HTTP_PROXY="http://proxy.example.com:8080"
   export HTTPS_PROXY="http://proxy.example.com:8080"
   aether config set proxy "http://proxy.example.com:8080"
   ```

3. **Use local providers for offline mode:**
   ```bash
   # Ollama (local LLM)
   ollama pull codellama:13b
   aether generate "..." --provider ollama --model codellama:13b

   # LM Studio
   aether generate "..." --provider lmstudio

   # LocalAI
   aether generate "..." --provider localai
   ```

4. **Increase timeout:**
   ```bash
   aether config set timeout 60000
   ```

---

## Path Not Found

**Symptoms:**
```
bash: aether: command not found
```
```
zsh: command not found: aether
```

**Solution:**

1. **Add Aether to your PATH:**
   ```bash
   # Add to ~/.bashrc or ~/.zshrc
   export PATH="$HOME/.aether-cli/bin:$PATH"
   ```

2. **Or create a system-wide symlink:**
   ```bash
   sudo ln -s "$(pwd)/bin/aether" /usr/local/bin/aether
   ```

3. **Verify the symlink:**
   ```bash
   which aether
   # Should output: /usr/local/bin/aether
   ```

4. **Reload your shell:**
   ```bash
   source ~/.bashrc  # or source ~/.zshrc
   # Or open a new terminal
   ```

---

## Permission Denied on Config Directories

**Symptoms:**
```
Error: EACCES: permission denied, open '~/.config/aether/config.json'
```

**Solution:**

```bash
mkdir -p ~/.config/aether ~/.local/share/aether ~/.cache/aether
chmod 755 ~/.config/aether ~/.local/share/aether ~/.cache/aether
```

On Termux:
```bash
mkdir -p $HOME/.config/aether $PREFIX/var/lib/aether $PREFIX/tmp/aether
```

---

## Build Failures

**Symptoms:**
```
Error: dist/cli.js not found and all build backends failed.
```

**Solution:**

1. **Build manually:**
   ```bash
   cd ~/.aether-cli
   bun install
   bun run build
   ```

2. **If Bun is not available, use npm:**
   ```bash
   npm install
   npm run build
   ```

3. **If esbuild is missing:**
   ```bash
   npx --yes esbuild src/cli.ts --bundle --platform=node --format=esm --outfile=dist/cli.js
   ```

4. **Clear and reinstall:**
   ```bash
   rm -rf node_modules dist
   bun install
   bun run build
   ```

---

## Termux-Specific Issues

### `bun` crashes or segfaults

Use Node.js instead:
```bash
pkg install nodejs
export AETHER_FORCE_NODE=1
aether generate "..." --provider openai
```

### Storage permission denied

Grant Termux storage access:
```bash
termux-setup-storage
```

### Low memory warnings

Aether automatically enables low-memory mode when < 2 GB RAM is available. If you still see issues:
```bash
export AETHER_LOW_MEMORY=1
```

---

## Getting More Help

1. **Run diagnostics:**
   ```bash
   aether doctor
   aether doctor --json
   aether doctor --fix
   ```

2. **Check environment info:**
   ```bash
   aether env
   ```

3. **Run the self-test suite:**
   ```bash
   aether self-test
   ```

4. **View current configuration:**
   ```bash
   aether config list
   ```

5. **Check for updates:**
   ```bash
   aether update --check
   ```
