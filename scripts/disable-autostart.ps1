$ErrorActionPreference='Stop'
$task = Get-ScheduledTask -TaskName 'CodexWeChatBridge' -ErrorAction SilentlyContinue
if ($task) { Unregister-ScheduledTask -TaskName 'CodexWeChatBridge' -Confirm:$false }
Write-Host 'Logon startup disabled. The running Bridge was not stopped.'
