#!/usr/bin/env bash
set -euo pipefail

REPO="${GME_RELEASE_REPO:-augustocaruso/gemini-md-export}"
BRANCH="${GME_RELEASE_BRANCH:-main}"
GEMINI_EXTENSION_SOURCE="${GME_GEMINI_EXTENSION_SOURCE:-https://www.github.com/$REPO.git}"
GEMINI_EXTENSION_REF="${GME_GEMINI_EXTENSION_REF:-gemini-cli-extension}"
INSTALL_DIR="${GME_INSTALL_DIR:-$HOME/Library/Application Support/GeminiMdExport}"
EXTENSION_LINK="${GME_EXTENSION_LINK:-$HOME/GeminiMdExport-extension}"
GEMINI_CLI_EXTENSION_DIR="$HOME/.gemini/extensions/gemini-md-export"
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

browser_extension_dir() {
  if [ -d "$GEMINI_CLI_EXTENSION_DIR/browser-extension" ]; then
    printf '%s/browser-extension' "$GEMINI_CLI_EXTENSION_DIR"
  else
    printf '%s/gemini-cli-extension/browser-extension' "$INSTALL_DIR"
  fi
}

link_browser_extension_dirs() {
  local browser_dir
  browser_dir="$(browser_extension_dir)"
  if [ ! -d "$browser_dir" ]; then
    warn "Pasta da extensao do navegador nao encontrada: $browser_dir"
    return
  fi

  rm -rf "$INSTALL_DIR/extension"
  ln -sfn "$browser_dir" "$INSTALL_DIR/extension"

  if [ -z "$EXTENSION_LINK" ]; then
    return
  fi

  if [ -e "$EXTENSION_LINK" ] && [ ! -L "$EXTENSION_LINK" ]; then
    warn "Nao criei atalho em $EXTENSION_LINK porque ja existe algo nesse caminho."
    return
  fi

  ln -sfn "$browser_dir" "$EXTENSION_LINK"
}

browser_extension_select_path() {
  if [ -n "$EXTENSION_LINK" ] && [ -e "$EXTENSION_LINK" ]; then
    printf '%s' "$EXTENSION_LINK"
  else
    browser_extension_dir
  fi
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

remove_installed_gemini_cli_extension() {
  local reason="${1:-reinstalacao}"
  if [ -d "$GEMINI_CLI_EXTENSION_DIR" ] || [ -L "$GEMINI_CLI_EXTENSION_DIR" ]; then
    rm -rf "$GEMINI_CLI_EXTENSION_DIR"
    log "Gemini CLI: pasta anterior removida ($reason): $GEMINI_CLI_EXTENSION_DIR"
  else
    log "Gemini CLI: nenhuma pasta anterior para remover em $GEMINI_CLI_EXTENSION_DIR"
  fi
}

expected_gemini_cli_extension_version() {
  node -p "require(process.argv[1]).version" "$INSTALL_DIR/gemini-cli-extension/package.json"
}

verify_gemini_cli_extension_install() {
  local manifest="$GEMINI_CLI_EXTENSION_DIR/gemini-extension.json"
  local expected_version
  expected_version="$(expected_gemini_cli_extension_version)"

  if [ ! -f "$manifest" ]; then
    warn "Gemini CLI: manifest instalado nao encontrado em $manifest"
    return 1
  fi

  node - "$manifest" "$expected_version" <<'NODE'
const fs = require('fs');
const path = require('path');
const [manifestPath, expectedVersion] = process.argv.slice(2);
const root = path.dirname(manifestPath);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const required = [
  path.join(root, 'src', 'mcp-server.js'),
  path.join(root, 'src', 'bridge-server.js'),
  path.join(root, 'bin', 'gemini-md-export.mjs'),
  path.join(root, 'browser-extension', 'manifest.json'),
  path.join(root, 'hooks', 'hooks.json'),
  path.join(root, 'skills', 'gemini-vault-sync', 'SKILL.md'),
];
const missing = required.filter((file) => !fs.existsSync(file));
if (manifest.name !== 'gemini-md-export') {
  console.error(`nome inesperado: ${manifest.name || '(vazio)'}`);
  process.exit(1);
}
if (String(manifest.version || '') !== String(expectedVersion || '')) {
  console.error(`versao inesperada: ${manifest.version || '(vazia)'}; esperada ${expectedVersion}`);
  process.exit(1);
}
if (!manifest.mcpServers || !manifest.mcpServers['gemini-md-export']) {
  console.error('mcpServers.gemini-md-export ausente');
  process.exit(1);
}
if (missing.length > 0) {
  console.error(`arquivos ausentes: ${missing.join(', ')}`);
  process.exit(1);
}
NODE
}

stop_running_mcp_processes() {
  log "Gemini CLI: encerrando MCPs antigos do exporter, se existirem"
  local pids
  pids="$(pgrep -f 'gemini-md-export.*mcp-server\.js|mcp-server\.js.*gemini-md-export' 2>/dev/null || true)"
  if [ -z "$pids" ]; then
    log "Gemini CLI: nenhum MCP antigo encontrado"
    return
  fi

  local pid
  for pid in $pids; do
    if [ "$pid" = "$$" ]; then
      continue
    fi
    if kill "$pid" >/dev/null 2>&1; then
      printf '  encerrado PID %s\n' "$pid" >&2
    else
      warn "nao consegui encerrar PID $pid"
    fi
  done
}

copy_gemini_cli_fallback() {
  warn "$1"
  mkdir -p "$HOME/.gemini/extensions"
  remove_installed_gemini_cli_extension "fallback manual"
  copy_dir "$INSTALL_DIR/gemini-cli-extension" "$HOME/.gemini/extensions/gemini-md-export"
  if verify_gemini_cli_extension_install; then
    warn "Gemini CLI configurado por copia manual fallback. Pode aparecer como not updatable."
  else
    fail "Fallback manual da extensao Gemini CLI tambem falhou."
  fi
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
    copy_gemini_cli_fallback "Gemini CLI nao encontrado; copiando extensao como fallback manual. Ela nao aparecera como atualizavel ate o Gemini CLI ser instalado."
    return
  fi

  log "Configurando Gemini CLI"
  stop_running_mcp_processes

  local attempt
  for attempt in 1 2; do
    log "Gemini CLI: desinstalando gemini-md-export antes de instalar novamente (tentativa $attempt)"
    gemini extensions uninstall gemini-md-export >/dev/null 2>&1 || true
    remove_installed_gemini_cli_extension "pre-install tentativa $attempt"

    if gemini extensions install "$GEMINI_EXTENSION_SOURCE" "--ref=$GEMINI_EXTENSION_REF" --auto-update --consent; then
      if verify_gemini_cli_extension_install; then
        printf 'Gemini CLI configurado via GitHub (%s --ref=%s --auto-update).\n' "$GEMINI_EXTENSION_SOURCE" "$GEMINI_EXTENSION_REF"
        return
      fi
      warn "gemini extensions install terminou, mas a extensao instalada nao foi verificada."
    else
      warn "gemini extensions install via GitHub falhou."
    fi

    if [ "$attempt" = "1" ]; then
      warn "Gemini CLI: tentando reinstalacao oficial mais uma vez."
    fi
  done

  copy_gemini_cli_fallback "Gemini CLI: instalacao oficial nao verificou; copiando extensao como fallback manual."
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
Browser extension path: $(browser_extension_dir)
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
4. Select this folder: $(browser_extension_select_path)
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
  patch_gemini_manifest
  write_launchers
  configure_gemini_cli
  link_browser_extension_dirs
  configure_claude
  write_summary
  open_browser_extensions

  printf '\n============================================================\n'
  printf '  Instalacao macOS concluida.\n'
  printf '============================================================\n\n'
  printf 'Extensao do navegador:\n  %s\n\n' "$(browser_extension_dir)"
  if [ -n "$EXTENSION_LINK" ] && [ -e "$EXTENSION_LINK" ]; then
    printf 'Atalho visivel para selecionar no Chrome:\n  %s\n\n' "$EXTENSION_LINK"
    open -R "$EXTENSION_LINK" >/dev/null 2>&1 || true
  fi
  printf 'Resumo:\n  %s/INSTALL-SUMMARY.txt\n\n' "$INSTALL_DIR"
  printf 'Proximo passo manual: em chrome://extensions, Load unpacked nessa pasta:\n  %s\n\n' "$(browser_extension_select_path)"
  printf 'Depois feche e reabra o Gemini CLI.\n'
}

main "$@"
