# Shell completion

Foreman ships completion scripts for bash, zsh, and fish via the `foreman completion <shell>` subcommand. The script is generated from Commander's command tree at runtime, so it always reflects the version you have installed — no separate file to keep in sync.

```bash
foreman completion bash
foreman completion zsh
foreman completion fish
```

Each prints the script to stdout. Pick the install path that matches your shell.

## bash

```bash
# system-wide (writable as root)
foreman completion bash | sudo tee /etc/bash_completion.d/foreman > /dev/null

# per-user
mkdir -p ~/.local/share/bash-completion/completions
foreman completion bash > ~/.local/share/bash-completion/completions/foreman

# or just source it from your shell rc once
echo 'source <(foreman completion bash)' >> ~/.bashrc
```

Reload the shell or `source ~/.bashrc`. `foreman <Tab><Tab>` should now list every subcommand.

## zsh

```bash
# fpath-based (preferred — works with compinit's cache)
mkdir -p ~/.zsh/completions
foreman completion zsh > ~/.zsh/completions/_foreman
# add to ~/.zshrc above the 'compinit' line:
echo 'fpath=(~/.zsh/completions $fpath)' >> ~/.zshrc

# or oh-my-zsh users:
foreman completion zsh > ~/.oh-my-zsh/completions/_foreman
```

Then in a fresh zsh: `compinit -u` and `foreman <Tab><Tab>` works.

## fish

```bash
foreman completion fish > ~/.config/fish/completions/foreman.fish
```

Fish reloads completions automatically on next launch — no `source` required.

## What completes

- Top-level subcommands: `init`, `start`, `mcp-stdio`, `log`, `policy`, `agent`, `secrets`, `registry`, `doctor`, `migrate-config`, `wrap`, `completion`.
- Nested subcommands: `foreman agent <Tab>` → `add list remove regenerate-key show block unblock`; same for `log`, `policy`, `secrets`, `registry`.
- Flags per subcommand (`--json`, `--yes`, `--type`, `--config-path`, …).

## What does not complete (yet)

- **Dynamic values** — agent ids from the registry, secret names from the store, log request ids. Today the script is static at install time. Dynamic context completion is on the v0.2+ list; see #70 for the issue.
- **PowerShell / cmd** — Windows-native is v0.2+. Until then WSL2 + bash/zsh/fish covers Windows.

## Homebrew

`brew install tuzlu07x/foreman/foreman` drops the bash + zsh + fish completion scripts into Homebrew's standard completion directories. No extra steps; reload your shell after install.

## Troubleshooting

| Symptom                                              | Fix                                                                                                       |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `foreman: command not found`                         | Add npm's global bin to PATH: `export PATH="$(npm prefix -g)/bin:$PATH"`. Then re-export the completion.  |
| Bash completes nothing                               | Confirm `bash-completion` is installed (`brew install bash-completion` on macOS).                          |
| zsh shows the menu but with no descriptions          | Ensure your zsh is ≥ 5.8 and `_describe` is wired in your rc — i.e. don't suppress it with a custom `_default`. |
| fish doesn't complete subcommands                    | Restart fish (`exec fish`). `~/.config/fish/completions/foreman.fish` is loaded once per shell startup.   |
