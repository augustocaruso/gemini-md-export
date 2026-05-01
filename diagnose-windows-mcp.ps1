param(
  [string]$ServerName = "gemini-md-export",
  [int]$Port = 47283
)

$ErrorActionPreference = "Stop"

function Write-Section {
  param([string]$Title)
  Write-Host ""
  Write-Host "== $Title =="
}

function Write-Info {
  param([string]$Message)
  Write-Host "[info] $Message"
}

function Write-Ok {
  param([string]$Message)
  Write-Host "[ok]   $Message"
}

function Write-Warn {
  param([string]$Message)
  Write-Host "[warn] $Message"
}

function Write-Fail {
  param([string]$Message)
  Write-Host "[fail] $Message"
}

function Get-JsonFile {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    return $null
  }
  $raw = Get-Content -LiteralPath $Path -Raw
  if ([string]::IsNullOrWhiteSpace($raw)) {
    return @{}
  }
  return ($raw | ConvertFrom-Json)
}

function Get-ProcessCommandLines {
  try {
    return Get-CimInstance Win32_Process -Filter "name = 'node.exe'" |
      Select-Object ProcessId, Name, CommandLine
  } catch {
    try {
      return Get-WmiObject Win32_Process -Filter "name = 'node.exe'" |
        Select-Object ProcessId, Name, CommandLine
    } catch {
      return @()
    }
  }
}

function Get-PortListeners {
  param([int]$ListenPort)
  try {
    return Get-NetTCPConnection -LocalPort $ListenPort -State Listen -ErrorAction Stop |
      Select-Object LocalAddress, LocalPort, OwningProcess, State
  } catch {
    $lines = netstat -ano -p tcp | Select-String -Pattern "LISTENING"
    $matches = @()
    foreach ($line in $lines) {
      $parts = ($line.ToString() -replace "\s+", " ").Trim().Split(" ")
      if ($parts.Length -lt 5) { continue }
      $local = $parts[1]
      $pid = $parts[-1]
      if ($local -match ":(\d+)$" -and [int]$Matches[1] -eq $ListenPort) {
        $matches += [pscustomobject]@{
          LocalAddress = $local
          LocalPort = $ListenPort
          OwningProcess = $pid
          State = "LISTENING"
        }
      }
    }
    return $matches
  }
}

function Test-Healthz {
  param([int]$ListenPort)
  $url = "http://127.0.0.1:$ListenPort/healthz"
  try {
    $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3
    return [pscustomobject]@{
      Ok = $true
      StatusCode = $response.StatusCode
      Body = $response.Content
    }
  } catch {
    return [pscustomobject]@{
      Ok = $false
      StatusCode = $null
      Body = $_.Exception.Message
    }
  }
}

function Test-AgentDiagnostics {
  param([int]$ListenPort)
  $url = "http://127.0.0.1:$ListenPort/agent/diagnostics"
  try {
    $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5
    $json = $null
    try {
      $json = $response.Content | ConvertFrom-Json
    } catch {
      $json = $null
    }
    return [pscustomobject]@{
      Ok = $true
      StatusCode = $response.StatusCode
      Body = $response.Content
      Json = $json
    }
  } catch {
    return [pscustomobject]@{
      Ok = $false
      StatusCode = $null
      Body = $_.Exception.Message
      Json = $null
    }
  }
}

function Join-CommandLine {
  param(
    [string]$Command,
    [object[]]$Args
  )
  $pieces = @()
  if ($Command) {
    $pieces += ('"{0}"' -f $Command)
  }
  foreach ($arg in ($Args | Where-Object { $_ -ne $null })) {
    $pieces += ('"{0}"' -f [string]$arg)
  }
  return ($pieces -join " ")
}

function Resolve-CommandPath {
  param([string]$Command)
  if ([string]::IsNullOrWhiteSpace($Command)) {
    return $null
  }
  if (Test-Path -LiteralPath $Command) {
    return (Resolve-Path -LiteralPath $Command).Path
  }
  try {
    $resolved = Get-Command $Command -ErrorAction Stop
    return $resolved.Source
  } catch {
    return $null
  }
}

function Resolve-TemplateString {
  param(
    [string]$Value,
    [string]$ExtensionPath
  )
  if ($null -eq $Value) { return $null }
  return ([string]$Value).
    Replace('${extensionPath}', $ExtensionPath).
    Replace('${/}', [IO.Path]::DirectorySeparatorChar)
}

$configPath = Join-Path $HOME ".gemini\settings.json"
$extensionsRoot = Join-Path $HOME ".gemini\extensions"
$extensionPath = Join-Path $extensionsRoot $ServerName
$extensionManifestPath = Join-Path $extensionPath "gemini-extension.json"

$summary = [ordered]@{
  configPath = $configPath
  extensionPath = $extensionPath
  serverName = $ServerName
  port = $Port
  configFound = $false
  extensionFound = $false
  legacyOverridePresent = $false
  commandExists = $false
  serverScriptExists = $false
  healthzOk = $false
  diagnosticsOk = $false
}

Write-Section "Gemini CLI config"
$config = $null
try {
  $config = Get-JsonFile -Path $configPath
  if ($null -eq $config) {
    Write-Fail "Config not found: $configPath"
  } else {
    $summary.configFound = $true
    Write-Ok "Config found: $configPath"
  }
} catch {
  Write-Fail ("Could not parse JSON: {0}" -f $_.Exception.Message)
}

Write-Section "Gemini CLI extension"
$extensionManifest = $null
try {
  $extensionManifest = Get-JsonFile -Path $extensionManifestPath
  if ($null -eq $extensionManifest) {
    Write-Fail "Extension not found: $extensionManifestPath"
  } else {
    $summary.extensionFound = $true
    Write-Ok "Extension found: $extensionManifestPath"
  }
} catch {
  Write-Fail ("Could not parse extension manifest: {0}" -f $_.Exception.Message)
}

$serverConfigOrigin = $null
$server = $null
if ($summary.configFound -and $config.mcpServers -and $config.mcpServers.$ServerName) {
  $summary.legacyOverridePresent = $true
  $server = $config.mcpServers.$ServerName
  $serverConfigOrigin = "settings.json override"
  Write-Warn "settings.json still defines '$ServerName'. This overrides the extension MCP config."
}

if (-not $server -and $summary.extensionFound -and $extensionManifest.mcpServers -and $extensionManifest.mcpServers.$ServerName) {
  $server = $extensionManifest.mcpServers.$ServerName
  $serverConfigOrigin = "gemini-extension.json"
  Write-Ok "Extension MCP entry '$ServerName' found."
} elseif (-not $server) {
  Write-Fail "MCP entry '$ServerName' was not found in the installed extension."
}

$command = $null
$commandResolved = $null
$serverArgs = @()
$serverScript = $null
$serverCwd = $null

if ($server) {
  $command = [string]$server.command
  if ($server.args) {
    $serverArgs = @($server.args) | ForEach-Object { Resolve-TemplateString -Value $_ -ExtensionPath $extensionPath }
  }
  $serverCwd = Resolve-TemplateString -Value ([string]$server.cwd) -ExtensionPath $extensionPath
  $serverScript = $serverArgs | Where-Object { [string]$_ -match "mcp-server\.js$" } | Select-Object -First 1
  $commandResolved = Resolve-CommandPath -Command $command

  Write-Info ("origin: {0}" -f $serverConfigOrigin)
  Write-Info ("command: {0}" -f $command)
  if ($commandResolved) {
    $summary.commandExists = $true
    Write-Ok ("resolved command: {0}" -f $commandResolved)
  } else {
    Write-Fail "Command path could not be resolved."
  }

  if ($serverArgs.Count -gt 0) {
    Write-Info ("args: {0}" -f ($serverArgs -join " "))
  } else {
    Write-Warn "args: none"
  }

  if ($serverCwd) {
    Write-Info ("cwd: {0}" -f $serverCwd)
  }

  if ($serverScript -and (Test-Path -LiteralPath $serverScript)) {
    $summary.serverScriptExists = $true
    Write-Ok "mcp-server.js exists."
  } else {
    Write-Fail "mcp-server.js path does not exist in the effective MCP config."
  }
}

Write-Section "Node processes"
$nodeProcesses = @(Get-ProcessCommandLines)
if ($nodeProcesses.Count -eq 0) {
  Write-Warn "No node.exe process found."
} else {
  foreach ($proc in $nodeProcesses) {
    $line = [string]$proc.CommandLine
    if ($line -match "gemini-md-export|mcp-server\.js|47283") {
      Write-Warn ("PID {0}: {1}" -f $proc.ProcessId, $line)
    }
  }
}

Write-Section "Port $Port"
$listeners = @(Get-PortListeners -ListenPort $Port)
if ($listeners.Count -eq 0) {
  Write-Warn "No listener found on port $Port."
} else {
  foreach ($listener in $listeners) {
    Write-Warn ("Listener on {0} (PID {1})" -f $listener.LocalAddress, $listener.OwningProcess)
  }
}

Write-Section "Bridge healthz"
$health = Test-Healthz -ListenPort $Port
if ($health.Ok) {
  $summary.healthzOk = $true
  Write-Ok ("healthz responded with HTTP {0}" -f $health.StatusCode)
  Write-Info ("body: {0}" -f $health.Body)
} else {
  Write-Warn ("healthz failed: {0}" -f $health.Body)
}

Write-Section "Environment diagnostics"
$diagnostics = Test-AgentDiagnostics -ListenPort $Port
if ($diagnostics.Ok) {
  $summary.diagnosticsOk = $true
  Write-Ok ("diagnostics responded with HTTP {0}" -f $diagnostics.StatusCode)
  if ($diagnostics.Json) {
    Write-Info ("status: {0}" -f $diagnostics.Json.status)
    if ($diagnostics.Json.nextAction) {
      Write-Info ("nextAction: {0} - {1}" -f $diagnostics.Json.nextAction.code, $diagnostics.Json.nextAction.message)
    }
    if ($diagnostics.Json.extension) {
      Write-Info ("extension clients: {0} connected, {1} matching" -f $diagnostics.Json.extension.connectedClientCount, $diagnostics.Json.extension.matchingClientCount)
    }
    if ($diagnostics.Json.export) {
      Write-Info ("export dir: {0}" -f $diagnostics.Json.export.outputDir)
    }
  } else {
    Write-Info ("body: {0}" -f $diagnostics.Body)
  }
} else {
  Write-Warn ("diagnostics failed: {0}" -f $diagnostics.Body)
}

Write-Section "Manual start command"
if ($command -and $serverScript) {
  Write-Host (Join-CommandLine -Command ($commandResolved ?? $command) -Args $serverArgs)
} else {
  Write-Warn "Could not assemble manual start command from the effective config."
}

Write-Section "Quick interpretation"
if (-not $summary.configFound) {
  Write-Fail "Gemini CLI config is missing."
} elseif (-not $summary.extensionFound) {
  Write-Fail "The installed Gemini CLI extension is missing."
} elseif ($summary.legacyOverridePresent) {
  Write-Fail "A legacy settings.json MCP override is shadowing the extension. Remove that entry."
} elseif (-not $summary.commandExists -or -not $summary.serverScriptExists) {
  Write-Fail "Gemini CLI points to stale paths."
} elseif ($listeners.Count -gt 1) {
  Write-Fail "More than one listener/process may be competing for the bridge."
} elseif ($listeners.Count -eq 1 -and -not $summary.healthzOk) {
  Write-Fail "Port is occupied but healthz is not healthy. Likely stale/orphan MCP."
} elseif (-not $summary.healthzOk) {
  Write-Warn "Extension looks installed, but the MCP is not running right now."
} elseif (-not $summary.diagnosticsOk) {
  Write-Warn "healthz works, but /agent/diagnostics failed. Use gemini_browser_status before reinstalling."
} else {
  Write-Ok "Gemini CLI extension and bridge look healthy."
}
