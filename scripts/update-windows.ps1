param(
  [string]$Repo = $env:GME_RELEASE_REPO,
  [string]$ZipUrl = $env:GME_RELEASE_ZIP_URL,
  [string]$Browser = $env:GME_BROWSER,
  [string]$InstallDir = $env:GME_INSTALL_DIR,
  [string]$LogPath = $env:GME_UPDATE_LOG_PATH,
  [switch]$DryRun,
  [switch]$KeepTemp,
  [switch]$NoOpenBrowser
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Repo)) {
  $Repo = 'augustocaruso/gemini-md-export'
}

if ([string]::IsNullOrWhiteSpace($Browser)) {
  $Browser = 'chrome'
}

if ([string]::IsNullOrWhiteSpace($ZipUrl)) {
  $ZipUrl = "https://github.com/$Repo/releases/latest/download/gemini-md-export-windows-prebuilt.zip"
}

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) "gemini-md-export-update-$timestamp"
$zipPath = Join-Path $tempRoot 'gemini-md-export-windows-prebuilt.zip'
$extractRoot = Join-Path $tempRoot 'payload'

if ([string]::IsNullOrWhiteSpace($LogPath)) {
  $LogPath = Join-Path $tempRoot 'update.log'
}

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host ">> $Message"
}

function Fail-Update {
  param([string]$Message)
  throw $Message
}

function Find-PayloadRoot {
  param([string]$Root)

  $candidates = @($Root)
  $candidates += Get-ChildItem -LiteralPath $Root -Directory -Recurse -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty FullName

  foreach ($candidate in $candidates) {
    $installer = Join-Path $candidate 'scripts\install-windows.mjs'
    $packageJson = Join-Path $candidate 'package.json'
    $extensionManifest = Join-Path $candidate 'dist\extension\manifest.json'
    $geminiManifest = Join-Path $candidate 'dist\gemini-cli-extension\gemini-extension.json'
    $mcpServer = Join-Path $candidate 'dist\gemini-cli-extension\src\mcp-server.js'

    if (
      (Test-Path -LiteralPath $installer) -and
      (Test-Path -LiteralPath $packageJson) -and
      (Test-Path -LiteralPath $extensionManifest) -and
      (Test-Path -LiteralPath $geminiManifest) -and
      (Test-Path -LiteralPath $mcpServer)
    ) {
      return $candidate
    }
  }

  return $null
}

function Read-JsonFile {
  param([string]$Path)
  return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Validate-Payload {
  param([string]$PayloadRoot)

  $packageJson = Read-JsonFile (Join-Path $PayloadRoot 'package.json')
  if ($packageJson.name -ne 'gemini-md-export') {
    Fail-Update "Pacote inesperado no update: $($packageJson.name)"
  }

  $extensionManifest = Read-JsonFile (Join-Path $PayloadRoot 'dist\extension\manifest.json')
  if ($extensionManifest.name -ne 'Gemini Chat -> Markdown Export') {
    Fail-Update "Extensao de navegador inesperada no pacote."
  }

  $geminiManifest = Read-JsonFile (Join-Path $PayloadRoot 'dist\gemini-cli-extension\gemini-extension.json')
  if ($geminiManifest.name -ne 'gemini-md-export') {
    Fail-Update "Extensao Gemini CLI inesperada no pacote."
  }

  return [PSCustomObject]@{
    Version = [string]$packageJson.version
    PayloadRoot = $PayloadRoot
  }
}

function Invoke-Installer {
  param([string]$PayloadRoot)

  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    Fail-Update "Node.js nao encontrado no PATH. Instale Node.js 20+ e rode o update novamente."
  }

  $args = @('scripts\install-windows.mjs', '--browser', $Browser)
  if (-not $NoOpenBrowser) {
    $args += '--open-browser'
  }
  if (-not [string]::IsNullOrWhiteSpace($InstallDir)) {
    $args += @('--install-dir', $InstallDir)
  }

  $env:GEMINI_INSTALL_PREBUILT_PAYLOAD = '1'
  try {
    if ($DryRun) {
      Write-Host "DRY-RUN: node $($args -join ' ')"
      return
    }

    Push-Location $PayloadRoot
    try {
      & $node.Source @args
      if ($LASTEXITCODE -ne 0) {
        Fail-Update "Instalador saiu com codigo $LASTEXITCODE."
      }
    } finally {
      Pop-Location
    }
  } finally {
    Remove-Item Env:\GEMINI_INSTALL_PREBUILT_PAYLOAD -ErrorAction SilentlyContinue
  }
}

$transcriptStarted = $false

try {
  New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LogPath) | Out-Null

  try {
    Start-Transcript -LiteralPath $LogPath -Force | Out-Null
    $transcriptStarted = $true
  } catch {
    Write-Host "[AVISO] Nao consegui iniciar log detalhado: $($_.Exception.Message)"
  }

  Write-Host "Gemini Markdown Export - update Windows"
  Write-Host "Repo: $Repo"
  Write-Host "URL:  $ZipUrl"
  Write-Host "Temp: $tempRoot"
  Write-Host "Log:  $LogPath"

  Write-Step "Baixando pacote mais recente"
  if ($DryRun) {
    Write-Host "DRY-RUN: baixaria $ZipUrl"
  } else {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $ZipUrl -OutFile $zipPath -UseBasicParsing
  }

  Write-Step "Extraindo pacote"
  if ($DryRun) {
    Write-Host "DRY-RUN: extrairia $zipPath para $extractRoot"
    New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null
  } else {
    Expand-Archive -LiteralPath $zipPath -DestinationPath $extractRoot -Force
  }

  if ($DryRun) {
    Write-Step "Validando payload"
    Write-Host "DRY-RUN: validaria package.json, manifest.json e gemini-extension.json"

    Write-Step "Executando instalador precompilado"
    Write-Host "DRY-RUN: executaria node scripts\install-windows.mjs --open-browser --browser $Browser"

    Write-Step "Concluido"
    Write-Host "DRY-RUN concluido sem alterar a instalacao."

    if ($transcriptStarted) {
      Stop-Transcript | Out-Null
      $transcriptStarted = $false
    }

    if (-not $KeepTemp) {
      Remove-Item -LiteralPath $tempRoot -Recurse -Force
      Write-Host "Arquivos temporarios removidos."
    } else {
      Write-Host "Arquivos temporarios preservados em: $tempRoot"
    }
    exit 0
  }

  Write-Step "Validando payload"
  $payloadRoot = Find-PayloadRoot -Root $extractRoot
  if (-not $payloadRoot) {
    Fail-Update "Nao encontrei o instalador precompilado dentro do pacote baixado."
  }
  $payload = Validate-Payload -PayloadRoot $payloadRoot
  Write-Host "Versao encontrada: $($payload.Version)"
  Write-Host "Payload: $($payload.PayloadRoot)"

  Write-Step "Executando instalador precompilado"
  Invoke-Installer -PayloadRoot $payload.PayloadRoot

  Write-Step "Concluido"
  Write-Host "Update instalado. Feche e reabra o Gemini CLI para carregar a nova versao."
  Write-Host "Se a extensao do navegador ja estava carregada, clique no reload do card em chrome://extensions."
  Write-Host "Depois desse reload do card, as abas abertas do Gemini devem recarregar sozinhas."

  if ($transcriptStarted) {
    Stop-Transcript | Out-Null
    $transcriptStarted = $false
  }

  if (-not $KeepTemp -and -not $DryRun) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force
    Write-Host "Arquivos temporarios removidos."
  } else {
    Write-Host "Arquivos temporarios preservados em: $tempRoot"
  }
} catch {
  Write-Host ""
  Write-Host "[ERRO] $($_.Exception.Message)"
  Write-Host "Arquivos temporarios preservados em: $tempRoot"
  Write-Host "Log: $LogPath"
  if ($transcriptStarted) {
    try { Stop-Transcript | Out-Null } catch {}
  }
  exit 1
}
