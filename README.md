# Publishing Amia's Official Claude Code Plugin (`amia`)

> Preserves `dist/claude-code/ac/` untouched for existing local runtime code while preparing the public GitHub repo layout required for Anthropic's official plugin directory (`claude.ai/directory/manage` → `claude-plugins-official`).

## Why rename `ac` → `amia` for the public directory

- Directory plugin names are permanent (`amia@claude-plugins-official`).
- Packages named after the product get picked reliably by coding agents and users searching by brand (`docs/896` §2.1–2.2).
- Once listed in `claude-plugins-official`, `ac` can emit `<claude-code-hint v="1" type="plugin" value="amia@claude-plugins-official" />` to stderr when `CLAUDECODE` is set, triggering Claude Code's built-in one-time install prompt.

## Public Repo Layout to Push (`github.com/amiahq/amia-claude-plugin`)

Copy `dist/claude-code/ac/bin/`, `dist/claude-code/ac/hooks/`, and `dist/claude-code/ac/.mcp.json` into `amia/`, and use the manifests in this folder:

- `.claude-plugin/marketplace.json` (provided beside this README)
- `amia/.claude-plugin/plugin.json` (provided beside this README)

## Submission Checklist (Owner Sign-In Required)

1. Create public GitHub repo `amiahq/amia-claude-plugin` and push the packaged tree.
2. Sign in with a paid Claude plan at `https://claude.ai/directory/manage`.
3. Submit the repo URL under name **`amia`** (`https://amia.to`, `support@amia.to`, `https://amia.to/privacy`).
4. Verify installation in a clean Claude Code session:
   - `/plugin marketplace add amiahq/amia-claude-plugin`
   - `/plugin install amia`
5. Once accepted into `claude-plugins-official`, wire the `<claude-code-hint>` line into `ac` CLI.
