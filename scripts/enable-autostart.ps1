. (Join-Path $PSScriptRoot 'common.ps1')
$userName = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$scriptPath = Join-Path $PSScriptRoot 'start.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -File "'+$scriptPath+'"') -WorkingDirectory $BridgeRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userName
$principal = New-ScheduledTaskPrincipal -UserId $userName -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName 'CodexWeChatBridge' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Local Codex WeChat Bridge, current user only' -Force | Out-Null
Write-Host 'Current-user logon startup enabled. No administrator service was installed.'
