# Raises this run's game to above-normal priority and says what it did (one line, for the run's console).
# Other lanes compile while a run goes, and the title's pipeline workers run below normal priority, so they starve
# without this (aftermath1: 2.1 translations a second against 17.8).
# -Translate raises run-world.sh's warm-up translate instead, which the same compilers starve (852 s against 682 s
# with it raised). The selection is shared with heavy-watch.mjs and shared between the two: see run-process.ps1.
# -Gentle (with -Translate) goes the other way: below normal, so the warm-up yields to OBS while the PC streams
# (run-world.sh picks it when OBS is running; obs.sh says when).
param([switch]$Translate, [switch]$Gentle)

# run-process.ps1's own `param` block resets a dot-sourcing caller's switches of the same names, so it is
# dot-sourced inside a child scope, with the value captured under a name it cannot reset first.
$selection = & {
  param($UseTranslate)
  . "$PSScriptRoot/run-process.ps1"
  Get-RunVictorySelection -Translate:$UseTranslate
} $Translate
$pick = @($selection.Process)
$class = if ($Gentle -and $Translate) { "BelowNormal" } else { "AboveNormal" }
$words = if ($class -eq "BelowNormal") { "below normal" } else { "above normal" }
$raised = @()
foreach ($c in $pick) {
  $p = Get-Process -Id $c.ProcessId -ErrorAction SilentlyContinue
  if ($p) { try { $p.PriorityClass = $class; $raised += $c.ProcessId } catch { } }
}
if ($raised.Count -gt 0) { "priority: $words for pid $($raised -join ', ') ($($selection.Rule))" }
else { "priority: no victory.exe raised ($(@($selection.All).Count) found)" }
