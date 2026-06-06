#requires -Version 5
# Install the snapstack server as a logon scheduled task:
# starts at login, restarts a few times on failure, and self-updates on each
# start (via deploy/snapstack-start.ps1). Idempotent — safe to re-run.
$ErrorActionPreference = 'Stop'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error 'node not found in PATH. Install Node.js >= 18 first.'; exit 1
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Warning 'git not found - auto-update at launch will be skipped.'
}

$launcher = Join-Path $PSScriptRoot 'snapstack-start.ps1'
$task     = 'snapstack'

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcher`""
$trigger  = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $task

Write-Host "Installed scheduled task: $task"
Write-Host "  launcher : $launcher"
Write-Host "Uninstall: Unregister-ScheduledTask -TaskName $task -Confirm:`$false"
