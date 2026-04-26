#!/usr/bin/env bash
set -euo pipefail

REPO="${GME_RELEASE_REPO:-augustocaruso/gemini-md-export}"
BRANCH="${GME_RELEASE_BRANCH:-main}"
GEMINI_EXTENSION_SOURCE="${GME_GEMINI_EXTENSION_SOURCE:-$REPO}"
GEMINI_EXTENSION_REF="${GME_GEMINI_EXTENSION_REF:-gemini-cli-extension}"
INSTALL_DIR="${GME_INSTALL_DIR:-$HOME/Library/Application Support/GeminiMdExport}"
EXTENSION_LINK="${GME_EXTENSION_LINK:-$HOME/GeminiMdExport-extension}"
EXPORT_DIR="${GME_EXPORT_DIR:-}"
BROWSER="${GME_BROWSER:-chrome}"
CONFIGURE_CLAUDE="${GME_CONFIGURE_CLAUDE:-auto}"
CONFIGURE_GEMINI="${GME_CONFIGURE_GEMINI:-auto}"
KEEP_TEMP="${GME_KEEP_TEMP:-0}"
INSTALL_TEMP_DIR=""

log() {
  printf '\n>> %s\n' "$*" >&2
}

warn() {
  printf '[AVISO] %s\n' "$*" >&2
}

fail() {
  printf '\n[ERRO] %s\n' "$*" >&2
  exit 1
}

require_node() {
  if ! command -v node >/dev/null 2>&1; then
    fail "Node.js nao encontrado. Instale com: brew install node"
  fi

  local major
  major="$(node -p 'Number(process.versions.node.split(".")[0])')"
  if [ "$major" -lt 20 ]; then
    fail "Node.js 20+ e necessario. Versao atual: $(node -v)"
  fi
}

download_source() {
  local temp_dir="$1"
  local tgz="$temp_dir/source.tar.gz"
  local url="https://github.com/$REPO/archive/refs/heads/$BRANCH.tar.gz"

  log "Baixando codigo fonte"
  printf 'Repo: %s\nBranch: %s\n' "$REPO" "$BRANCH" >&2
  if ! curl --retry 4 --retry-delay 2 --retry-all-errors -fL "$url" -o "$tgz"; then
    return 1
  fi
  tar -xzf "$tgz" -C "$temp_dir"
  find "$temp_dir" -mindepth 1 -maxdepth 1 -type d -name 'gemini-md-export-*' | head -n 1
}

copy_dir() {
  local src="$1"
  local dst="$2"
  rm -rf "$dst"
  mkdir -p "$(dirname "$dst")"
  cp -R "$src" "$dst"
}

create_visible_extension_link() {
  if [ -z "$EXTENSION_LINK" ]; then
    return
  fi

  if [ -e "$EXTENSION_LINK" ] && [ ! -L "$EXTENSION_LINK" ]; then
    warn "Nao criei atalho em $EXTENSION_LINK porque ja existe algo nesse caminho."
    return
  fi

  ln -sfn "$INSTALL_DIR/extension" "$EXTENSION_LINK"
}

browser_url() {
  case "$(printf '%s' "$BROWSER" | tr '[:upper:]' '[:lower:]')" in
    edge) printf 'edge://extensions' ;;
    brave) printf 'brave://extensions' ;;
    *) printf 'chrome://extensions' ;;
  esac
}

open_browser_extensions() {
  local url
  url="$(browser_url)"
  log "Abrindo pagina de extensoes"
  case "$(printf '%s' "$BROWSER" | tr '[:upper:]' '[:lower:]')" in
    edge)
      open -a "Microsoft Edge" "$url" >/dev/null 2>&1 || warn "Abra manualmente: $url"
      ;;
    brave)
      open -a "Brave Browser" "$url" >/dev/null 2>&1 || warn "Abra manualmente: $url"
      ;;
    *)
      open -a "Google Chrome" "$url" >/dev/null 2>&1 || open "$url" >/dev/null 2>&1 || warn "Abra manualmente: $url"
      ;;
  esac
}

write_launchers() {
  local mcp_server="$INSTALL_DIR/gemini-cli-extension/src/mcp-server.js"
  local node_bin
  node_bin="$(command -v node)"

  cat > "$INSTALL_DIR/start-mcp.command" <<EOF
#!/usr/bin/env bash
cd "$(printf '%s' "$INSTALL_DIR/gemini-cli-extension")"
EOF
  if [ -n "$EXPORT_DIR" ]; then
    printf 'export GEMINI_MCP_EXPORT_DIR=%q\n' "$EXPORT_DIR" >> "$INSTALL_DIR/start-mcp.command"
  fi
  printf 'exec %q %q\n' "$node_bin" "$mcp_server" >> "$INSTALL_DIR/start-mcp.command"

  cat > "$INSTALL_DIR/open-browser-extensions.command" <<EOF
#!/usr/bin/env bash
case "$(printf '%s' "$BROWSER" | tr '[:upper:]' '[:lower:]')" in
  edge)
    open -a "Microsoft Edge" "$(browser_url)" >/dev/null 2>&1 || open "$(browser_url)"
    ;;
  brave)
    open -a "Brave Browser" "$(browser_url)" >/dev/null 2>&1 || open "$(browser_url)"
    ;;
  *)
    open -a "Google Chrome" "$(browser_url)" >/dev/null 2>&1 || open "$(browser_url)"
    ;;
esac
EOF

  cat > "$INSTALL_DIR/open-gemini.command" <<'EOF'
#!/usr/bin/env bash
open "https://gemini.google.com/app"
EOF

  cat > "$INSTALL_DIR/reveal-extension-folder.command" <<EOF
#!/usr/bin/env bash
if [ -n "$(printf '%s' "$EXTENSION_LINK")" ] && [ -e "$(printf '%s' "$EXTENSION_LINK")" ]; then
  open -R "$(printf '%s' "$EXTENSION_LINK")"
else
  open -R "$(printf '%s' "$INSTALL_DIR/extension/manifest.json")"
fi
EOF

  chmod +x "$INSTALL_DIR/start-mcp.command" "$INSTALL_DIR/open-browser-extensions.command" "$INSTALL_DIR/open-gemini.command" "$INSTALL_DIR/reveal-extension-folder.command"
}

patch_gemini_manifest() {
  local manifest="$INSTALL_DIR/gemini-cli-extension/gemini-extension.json"
  local node_bin
  node_bin="$(command -v node)"

  node - "$manifest" "$node_bin" "$EXPORT_DIR" <<'NODE'
const fs = require('fs');
const [manifestPath, nodeBin, exportDir] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.mcpServers = manifest.mcpServers || {};
manifest.mcpServers['gemini-md-export'] = {
  ...(manifest.mcpServers['gemini-md-export'] || {}),
  command: nodeBin,
  args: ['${extensionPath}${/}src${/}mcp-server.js'],
  cwd: '${extensionPath}',
};
if (exportDir) {
  manifest.mcpServers['gemini-md-export'].env = {
    GEMINI_MCP_EXPORT_DIR: exportDir,
  };
}
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
NODE
}

configure_gemini_cli() {
  if [ "$CONFIGURE_GEMINI" = "0" ] || [ "$CONFIGURE_GEMINI" = "false" ]; then
    warn "Gemini CLI pulado por GME_CONFIGURE_GEMINI=$CONFIGURE_GEMINI"
    return
  fi

  if ! command -v gemini >/dev/null 2>&1; then
    if [ "$CONFIGURE_GEMINI" = "1" ] || [ "$CONFIGURE_GEMINI" = "true" ]; then
      fail "gemini nao encontrado no PATH."
    fi
    warn "Gemini CLI nao encontrado; copiando extensao como fallback manual. Ela nao aparecera como atualizavel ate o Gemini CLI ser instalado."
    mkdir -p "$HOME/.gemini/extensions"
    copy_dir "$INSTALL_DIR/gemini-cli-extension" "$HOME/.gemini/extensions/gemini-md-export"
    return
  fi

  log "Configurando Gemini CLI"
  gemini extensions uninstall gemini-md-export >/dev/null 2>&1 || true
  if gemini extensions install "$GEMINI_EXTENSION_SOURCE" "--ref=$GEMINI_EXTENSION_REF" --auto-update --consent; then
    printf 'Gemini CLI configurado via GitHub (%s --ref=%s --auto-update).\n' "$GEMINI_EXTENSION_SOURCE" "$GEMINI_EXTENSION_REF"
  else
    warn "gemini extensions install via GitHub falhou; copiando extensao como fallback manual. Ela pode aparecer como not updatable."
    mkdir -p "$HOME/.gemini/extensions"
    copy_dir "$INSTALL_DIR/gemini-cli-extension" "$HOME/.gemini/extensions/gemini-md-export"
  fi
}

configure_claude() {
  if [ "$CONFIGURE_CLAUDE" = "0" ] || [ "$CONFIGURE_CLAUDE" = "false" ]; then
    return
  fi

  local config="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
  local config_dir
  config_dir="$(dirname "$config")"
  if [ "$CONFIGURE_CLAUDE" = "auto" ] && [ ! -d "$config_dir" ] && [ ! -f "$config" ]; then
    return
  fi

  log "Configurando Claude Desktop"
  mkdir -p "$config_dir"
  if [ -f "$config" ]; then
    cp "$config" "$config.bak-$(date +%Y%m%d-%H%M%S)"
  else
    printf '{}\n' > "$config"
  fi

  node - "$config" "$INSTALL_DIR/gemini-cli-extension/src/mcp-server.js" "$(command -v node)" "$EXPORT_DIR" <<'NODE'
const fs = require('fs');
const [configPath, serverPath, nodeBin, exportDir] = process.argv.slice(2);
let config = {};
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8') || '{}');
} catch {
  config = {};
}
config.mcpServers = config.mcpServers || {};
config.mcpServers['gemini-md-export'] = {
  command: nodeBin,
  args: [serverPath],
};
if (exportDir) {
  config.mcpServers['gemini-md-export'].env = {
    GEMINI_MCP_EXPORT_DIR: exportDir,
  };
}
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
NODE
}

write_summary() {
  local summary="$INSTALL_DIR/INSTALL-SUMMARY.txt"
  cat > "$summary" <<EOF
Gemini Markdown Export - macOS install summary

Installed app: $INSTALL_DIR
Browser extension path: $INSTALL_DIR/extension
Visible browser extension shortcut: ${EXTENSION_LINK:-"(disabled)"}
Gemini CLI extension bundle: $INSTALL_DIR/gemini-cli-extension
Gemini CLI install source: $GEMINI_EXTENSION_SOURCE --ref=$GEMINI_EXTENSION_REF --auto-update
MCP server: $INSTALL_DIR/gemini-cli-extension/src/mcp-server.js
Node: $(command -v node)
Export dir override: ${EXPORT_DIR:-"(none; default is Downloads or folder chosen in modal)"}

Manual browser step:
1. Open $(browser_url).
2. Enable Developer mode.
3. Click Load unpacked.
4. Select this visible shortcut: ${EXTENSION_LINK:-"$INSTALL_DIR/extension"}
5. If the extension already existed, click reload on its card.

Gemini CLI:
- Close and reopen Gemini CLI.
- Run /mcp to check gemini-md-export.
- If it says "not updatable", rerun this installer after confirming git is installed.

Launchers:
- $INSTALL_DIR/start-mcp.command
- $INSTALL_DIR/open-browser-extensions.command
- $INSTALL_DIR/reveal-extension-folder.command
- $INSTALL_DIR/open-gemini.command
EOF
}

main() {
  [ "$(uname -s)" = "Darwin" ] || fail "Este instalador e para macOS."
  require_node

  local source_dir
  INSTALL_TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/gemini-md-export-macos.XXXXXX")"
  trap 'if [ "$KEEP_TEMP" != "1" ]; then rm -rf "$INSTALL_TEMP_DIR"; else printf "\nTemp preservado em: %s\n" "$INSTALL_TEMP_DIR"; fi' EXIT

  source_dir="$(download_source "$INSTALL_TEMP_DIR")"
  [ -n "$source_dir" ] || fail "Nao consegui localizar o codigo baixado."

  log "Instalando dependencias e gerando build"
  cd "$source_dir"
  npm install
  npm run build

  log "Instalando em $INSTALL_DIR"
  mkdir -p "$INSTALL_DIR"
  copy_dir "$source_dir/dist/extension" "$INSTALL_DIR/extension"
  copy_dir "$source_dir/dist/gemini-cli-extension" "$INSTALL_DIR/gemini-cli-extension"
  create_visible_extension_link
  patch_gemini_manifest
  write_launchers
  configure_gemini_cli
  configure_claude
  write_summary
  open_browser_extensions

  printf '\n============================================================\n'
  printf '  Instalacao macOS concluida.\n'
  printf '============================================================\n\n'
  printf 'Extensao do navegador:\n  %s/extension\n\n' "$INSTALL_DIR"
  if [ -n "$EXTENSION_LINK" ] && [ -e "$EXTENSION_LINK" ]; then
    printf 'Atalho visivel para selecionar no Chrome:\n  %s\n\n' "$EXTENSION_LINK"
    open -R "$EXTENSION_LINK" >/dev/null 2>&1 || true
  fi
  printf 'Resumo:\n  %s/INSTALL-SUMMARY.txt\n\n' "$INSTALL_DIR"
  printf 'Proximo passo manual: em chrome://extensions, Load unpacked nessa pasta:\n  %s\n\n' "${EXTENSION_LINK:-"$INSTALL_DIR/extension"}"
  printf 'Depois feche e reabra o Gemini CLI.\n'
}

main "$@"
