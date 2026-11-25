# Records a short Windows Performance Recorder trace while the game runs: what every thread and the graphics card
# are doing, running or waiting. Run it from an ADMINISTRATOR PowerShell while a run is in its settled scene:
#     powershell -ExecutionPolicy Bypass -File <this script>
# The trace is system-wide (process names, file paths, call stacks), so it stays on this PC: it is written under
# <VICTORY_CAPTURES, default %USERPROFILE%\victory-captures>\wpr\, outside every repository, and never
# committed or posted.
param([int]$Seconds = 15)
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "This needs an administrator PowerShell (right-click PowerShell, Run as administrator)."; exit 1
}
if (-not (Get-Process victory -ErrorAction SilentlyContinue)) {
  Write-Host "The game is not running. Start a run and wait until it reaches the world, then run this again."; exit 1
}
$dir = if ($env:VICTORY_CAPTURES) { Join-Path $env:VICTORY_CAPTURES "wpr" } else { Join-Path $env:USERPROFILE "victory-captures\wpr" }
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$out = Join-Path $dir ("trace-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".etl")
& wpr.exe -cancel 2>$null | Out-Null
& wpr.exe -start GeneralProfile -start GPU -filemode
if ($LASTEXITCODE -ne 0) { Write-Host "The recorder did not start (exit $LASTEXITCODE)."; exit 1 }
Write-Host "Recording for $Seconds seconds..."
Start-Sleep -Seconds $Seconds
& wpr.exe -stop $out "game run, settled scene"
if ($LASTEXITCODE -ne 0) { Write-Host "The recorder did not stop cleanly (exit $LASTEXITCODE)."; exit 1 }
$mb = [math]::Round((Get-Item $out).Length / 1MB)
Write-Host "Done: trace-$((Get-Item $out).BaseName.Substring(6)) ($mb MB) in the captures folder. Tell the lead it is there."
