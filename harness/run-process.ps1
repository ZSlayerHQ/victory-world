# Shared selection of this run's victory.exe, used by raise-priority.ps1 and heavy-watch.mjs.
#
# Selection, narrowest first: the victory.exe started by this run (" run " and the game's path on its command
# line, created after the run began); else any victory.exe created after the run began; else every victory.exe.
# A wrongly raised offline `victory.exe translate` costs nothing; a game left at normal priority can waste the run.
# -Strict returns only the first rule: anything that ends the process must never fall back to a stale offline
# victory.exe.
# -Translate selects the warm-up instead: a victory.exe created after the warm-up began (its start in
# RUN_WORLD_WARM_STARTED_EPOCH) whose command line has " warm ". It never falls back, so a real
# game can never be selected (a gotcha). The environment comes from run-world.sh: RUN_WORLD_GAME_EXE,
# RUN_WORLD_STARTED_EPOCH, RUN_WORLD_WARM_STARTED_EPOCH.
param([switch]$Strict, [switch]$Pids, [switch]$Translate)

function Get-RunVictorySelection {
  param([switch]$Strict, [switch]$Translate)

  $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq "victory.exe" })
  if ($Translate) {
    $started = [long]$env:RUN_WORLD_WARM_STARTED_EPOCH
    $pick = @()
    if ($started -gt 0) {
      $fresh = @($all | Where-Object { $_.CreationDate -and ([DateTimeOffset]$_.CreationDate).ToUnixTimeSeconds() -ge ($started - 2) })
      $pick = @($fresh | Where-Object {
          $_.CommandLine -and $_.CommandLine -match " warm "
        })
    }
    [pscustomobject]@{ Process = $pick; Rule = "this run's warm-up"; All = $all }
    return
  }

  $game = $env:RUN_WORLD_GAME_EXE -replace "/", "\"
  $started = [long]$env:RUN_WORLD_STARTED_EPOCH
  $fresh = @($all | Where-Object { $_.CreationDate -and ([DateTimeOffset]$_.CreationDate).ToUnixTimeSeconds() -ge ($started - 2) })
  $mine = @()
  if ($game -and $started -gt 0) {
    $mine = @($fresh | Where-Object {
        $_.CommandLine -and $_.CommandLine -match " run " -and
        ($_.CommandLine -replace "/", "\").IndexOf($game, [StringComparison]::OrdinalIgnoreCase) -ge 0
      })
  }

  $rule = "this run's game"
  $pick = $mine
  if (-not $Strict) {
    if ($pick.Count -eq 0) { $pick = $fresh; $rule = "started with this run" }
    if ($pick.Count -eq 0) { $pick = $all; $rule = "every victory.exe" }
  }
  [pscustomobject]@{ Process = $pick; Rule = $rule; All = $all }
}

# Run directly (not dot-sourced): print this run's pids, one per line, for heavy-watch.mjs.
if ($MyInvocation.InvocationName -ne '.') {
  $selection = Get-RunVictorySelection -Strict:$Strict -Translate:$Translate
  if ($Pids) {
    @($selection.Process | ForEach-Object { $_.ProcessId }) -join "`n"
  }
}
