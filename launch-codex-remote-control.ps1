param(
    [int]$RendererDebugPort = 9322,
    [int]$MainInspectorPort = 9333,
    [int]$StartupDelaySeconds = 2
)

$ErrorActionPreference = 'Stop'
$package = Get-AppxPackage OpenAI.Codex
if (-not $package) {
    throw 'The OpenAI.Codex Microsoft Store package is not installed.'
}

$codexExecutable = Join-Path $package.InstallLocation 'app\ChatGPT.exe'
$rendererInjector = Join-Path $PSScriptRoot 'inject-codex-remote-control-ui.mjs'
$remoteWorkspaceInjector = Join-Path $PSScriptRoot 'inject-codex-remote-project-sync.mjs'
$mainEvaluator = Join-Path $PSScriptRoot 'evaluate-codex-main.mjs'
$mainShim = Join-Path $PSScriptRoot 'codex-main-remote-control-shim.js'
$logFile = Join-Path $env:TEMP 'codexwinsync.log'
$nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
$nodeVersion = & $nodeExecutable --version
$nodeMajor = [int](($nodeVersion -replace '^v', '').Split('.')[0])

if ($nodeMajor -lt 22) {
    throw "Node.js 22 or newer is required. Found $nodeVersion."
}

foreach ($requiredFile in @($codexExecutable, $rendererInjector, $remoteWorkspaceInjector, $mainEvaluator, $mainShim)) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        throw "Required file not found: $requiredFile"
    }
}

if ($StartupDelaySeconds -gt 0) {
    Start-Sleep -Seconds $StartupDelaySeconds
}

Get-Process -Name ChatGPT -ErrorAction SilentlyContinue |
    Where-Object {
        try {
            $_.Path -eq $codexExecutable
        } catch {
            $false
        }
    } |
    Stop-Process -Force

$exitDeadline = (Get-Date).AddSeconds(15)
do {
    $running = Get-Process -Name ChatGPT -ErrorAction SilentlyContinue |
        Where-Object {
            try {
                $_.Path -eq $codexExecutable
            } catch {
                $false
            }
        }
    if ($running) {
        Start-Sleep -Milliseconds 250
    }
} while ($running -and (Get-Date) -lt $exitDeadline)

"[$(Get-Date -Format o)] Launching codexwinsync." |
    Set-Content -LiteralPath $logFile -Encoding utf8

Start-Process -FilePath $codexExecutable -ArgumentList @(
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=$RendererDebugPort",
    "--inspect=127.0.0.1:$MainInspectorPort"
)

& $nodeExecutable $mainEvaluator "$MainInspectorPort" '--file' $mainShim 2>&1 |
    Out-File -LiteralPath $logFile -Append -Encoding utf8
if ($LASTEXITCODE -ne 0) {
    throw "Main-process remote-control shim failed. See $logFile"
}

& $nodeExecutable $rendererInjector "$RendererDebugPort" '30000' 2>&1 |
    Out-File -LiteralPath $logFile -Append -Encoding utf8
if ($LASTEXITCODE -ne 0) {
    throw "Renderer remote-control override failed. See $logFile"
}

& $nodeExecutable $remoteWorkspaceInjector "$RendererDebugPort" '30000' 2>&1 |
    Out-File -LiteralPath $logFile -Append -Encoding utf8
if ($LASTEXITCODE -ne 0) {
    throw "Remote workspace metadata sync failed. See $logFile"
}

"[$(Get-Date -Format o)] Runtime remote control enabled." |
    Add-Content -LiteralPath $logFile -Encoding utf8

Write-Host 'codexwinsync enabled.'
Write-Host 'Existing projects and chats on connected hosts will be imported into the sidebar automatically.'
Write-Host 'Open Settings -> Connections -> Control other devices.'
Write-Host "Diagnostics: $logFile"
