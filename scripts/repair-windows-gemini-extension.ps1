param(
  [string]$Repo = $env:GME_RELEASE_REPO,
  [string]$Ref = $env:GME_GEMINI_EXTENSION_REF,
  [string]$ServerName = "gemini-md-export"
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Repo)) {
  $Repo = "augustocaruso/gemini-md-export"
}

if ([string]::IsNullOrWhiteSpace($Ref)) {
  $Ref = "gemini-cli-extension"
}

$ExtensionPath = Join-Path $HOME ".gemini\extensions\$ServerName"
$SettingsPath = Join-Path $HOME ".gemini\settings.json"
$InstallUrl = "https://www.github.com/$Repo.git"

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host ">> $Message"
}

function Write-Info {
  param([string]$Message)
  Write-Host "   $Message"
}

function Write-WarnLine {
  param([string]$Message)
  Write-Host "   [aviso] $Message"
}

function Resolve-GeminiCommand {
  $command = Get-Command gemini -ErrorAction SilentlyContinue
  if (-not $command) {
    throw "Gemini CLI nao foi encontrado no PATH. Abra um novo PowerShell depois de instalar o Gemini CLI e tente novamente."
  }
  return $command.Source
}

function Test-TextContains {
  param(
    [string]$Text,
    [string]$Needle
  )
  if ([string]::IsNullOrWhiteSpace($Text) -or [string]::IsNullOrWhiteSpace($Needle)) {
    return $false
  }
  return $Text.IndexOf($Needle, [StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Get-CandidateProcesses {
  $items = @()
  $filters = @("name = 'node.exe'", "name = 'gemini.exe'")

  foreach ($filter in $filters) {
    try {
      $items += Get-CimInstance Win32_Process -Filter $filter |
        Select-Object ProcessId, Name, CommandLine
    } catch {
      try {
        $items += Get-WmiObject Win32_Process -Filter $filter |
          Select-Object ProcessId, Name, CommandLine
      } catch {
        Write-WarnLine "Nao consegui listar processos para filtro: $filter"
      }
    }
  }

  return $items
}

function Stop-ExporterProcesses {
  param([string]$PathToRelease)

  $stopped = 0
  $normalizedPath = [string]$PathToRelease
  $candidateProcesses = @(Get-CandidateProcesses)

  foreach ($proc in $candidateProcesses) {
    $line = [string]$proc.CommandLine
    $matchesExporter =
      (Test-TextContains -Text $line -Needle $ServerName) -or
      (Test-TextContains -Text $line -Needle "mcp-server.js") -or
      (Test-TextContains -Text $line -Needle $normalizedPath)

    if (-not $matchesExporter) {
      continue
    }

    try {
      Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
      $stopped += 1
      Write-Info ("encerrado PID {0}: {1}" -f $proc.ProcessId, $proc.Name)
    } catch {
      Write-WarnLine ("nao consegui encerrar PID {0}: {1}" -f $proc.ProcessId, $_.Exception.Message)
    }
  }

  if ($stopped -eq 0) {
    Write-Info "nenhum processo antigo do exporter encontrado"
  }

  Start-Sleep -Milliseconds 500
}

function Invoke-Gemini {
  param(
    [string]$GeminiCommand,
    [string[]]$GeminiArgs,
    [string]$Label,
    [switch]$IgnoreFailure
  )

  Write-Info ("gemini {0}" -f ($GeminiArgs -join " "))
  & $GeminiCommand @GeminiArgs
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0 -and -not $IgnoreFailure) {
    throw "$Label falhou com codigo $exitCode."
  }
  if ($exitCode -ne 0) {
    Write-WarnLine "$Label retornou codigo $exitCode; seguindo mesmo assim."
  }
}

function Remove-DirectoryWithRetry {
  param([string]$PathToRemove)

  if (-not (Test-Path -LiteralPath $PathToRemove)) {
    Write-Info "pasta antiga nao existe"
    return
  }

  for ($attempt = 1; $attempt -le 8; $attempt += 1) {
    try {
      Remove-Item -LiteralPath $PathToRemove -Recurse -Force -ErrorAction Stop
      Write-Info "pasta antiga removida"
      return
    } catch {
      Write-WarnLine ("tentativa {0}/8 falhou ao remover pasta: {1}" -f $attempt, $_.Exception.Message)
      Stop-ExporterProcesses -PathToRelease $PathToRemove
      Start-Sleep -Milliseconds (500 * $attempt)
    }
  }

  $staleName = "$ServerName-stale-$(Get-Date -Format yyyyMMdd-HHmmss)"
  $stalePath = Join-Path (Split-Path -Parent $PathToRemove) $staleName
  try {
    Rename-Item -LiteralPath $PathToRemove -NewName $staleName -Force -ErrorAction Stop
    Write-WarnLine "pasta antiga ainda estava travada; renomeei para $stalePath"
    return
  } catch {
    throw "Nao consegui remover nem renomear $PathToRemove. Feche todas as janelas do Gemini CLI/terminal e rode este reparo de novo. Detalhe: $($_.Exception.Message)"
  }
}

function Remove-LegacySettingsOverride {
  if (-not (Test-Path -LiteralPath $SettingsPath)) {
    return
  }

  try {
    $settings = Get-Content -LiteralPath $SettingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    Write-WarnLine "nao consegui ler settings.json; nao vou alterar esse arquivo"
    return
  }

  $changed = $false
  if ($settings.mcpServers -and $settings.mcpServers.PSObject.Properties[$ServerName]) {
    $settings.mcpServers.PSObject.Properties.Remove($ServerName)
    $changed = $true
    Write-Info "override legado em mcpServers removido do settings.json"

    if ($settings.mcpServers.PSObject.Properties.Count -eq 0) {
      $settings.PSObject.Properties.Remove("mcpServers")
    }
  }

  if ($settings.mcp -and $settings.mcp.excluded) {
    $excluded = @()
    foreach ($item in @($settings.mcp.excluded)) {
      if ([string]$item -ne $ServerName) {
        $excluded += $item
      } else {
        $changed = $true
      }
    }
    $settings.mcp.excluded = $excluded
  }

  if ($changed) {
    $settings | ConvertTo-Json -Depth 50 | Set-Content -LiteralPath $SettingsPath -Encoding UTF8
  }
}

function Assert-InstalledExtension {
  $manifestPath = Join-Path $ExtensionPath "gemini-extension.json"
  if (-not (Test-Path -LiteralPath $manifestPath)) {
    throw "Instalacao terminou, mas gemini-extension.json nao apareceu em $manifestPath"
  }

  $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($manifest.name -ne $ServerName) {
    throw "Manifest instalado inesperado: $($manifest.name)"
  }

  $mcp = $manifest.mcpServers.$ServerName
  if (-not $mcp) {
    throw "Manifest instalado nao tem mcpServers.$ServerName"
  }

  if ($mcp.PSObject.Properties["cwd"]) {
    throw "Manifest instalado ainda tem cwd. Isso pode travar auto-update no Windows."
  }

  Write-Info ("versao instalada: {0}" -f $manifest.version)
  Write-Info "manifest verificado sem cwd"
}

try {
  Write-Host "Gemini MD Export - reparo limpo da extensao Gemini CLI"
  Write-Host "Repo: $Repo"
  Write-Host "Ref:  $Ref"

  $geminiCommand = Resolve-GeminiCommand
  Write-Info "Gemini CLI: $geminiCommand"

  Write-Step "Encerrando processos antigos do exporter"
  Stop-ExporterProcesses -PathToRelease $ExtensionPath

  Write-Step "Removendo extensao antiga do Gemini CLI"
  Invoke-Gemini -GeminiCommand $geminiCommand -GeminiArgs @("extensions", "uninstall", $ServerName) -Label "gemini extensions uninstall" -IgnoreFailure
  Stop-ExporterProcesses -PathToRelease $ExtensionPath
  Remove-DirectoryWithRetry -PathToRemove $ExtensionPath
  Remove-LegacySettingsOverride

  Write-Step "Instalando extensao atualizavel pelo GitHub"
  Invoke-Gemini -GeminiCommand $geminiCommand -GeminiArgs @("extensions", "install", $InstallUrl, "--ref=$Ref", "--auto-update", "--consent") -Label "gemini extensions install"

  Write-Step "Verificando instalacao"
  Assert-InstalledExtension

  Write-Host ""
  Write-Host "OK: reparo concluido."
  Write-Host "Agora feche e reabra o Gemini CLI. Depois recarregue o card da extensao em chrome://extensions se o navegador ainda estiver com a versao antiga."
} catch {
  Write-Host ""
  Write-Host "[ERRO] $($_.Exception.Message)"
  Write-Host "Se continuar falhando, feche todas as janelas do Gemini CLI, Chrome/Edge que estejam usando a extensao, e rode o reparo de novo."
  exit 1
}
