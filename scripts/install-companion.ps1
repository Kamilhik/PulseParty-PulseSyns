param([switch]$AutoStart, [switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$installDirectory = Join-Path $env:LOCALAPPDATA 'PulseParty'
$protocolKey = 'HKCU:\Software\Classes\pulseparty'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
if ($Uninstall) {
    if (Test-Path -LiteralPath $protocolKey) { Remove-Item -LiteralPath $protocolKey -Recurse -Force }
    Remove-ItemProperty -LiteralPath $runKey -Name 'PulseParty' -ErrorAction SilentlyContinue
    Write-Host 'Схема и автозапуск удалены. Остановите companion. Локальные данные сохранены в' $installDirectory
    exit
}
$nodePath = (Get-Command node).Source
$mainPath = Join-Path $taskRoot 'dist\services\companion\main.js'
if (!(Test-Path -LiteralPath $mainPath)) { throw 'Сначала выполните npm run build' }
$envPath = Join-Path $taskRoot '.env'
if (!(Test-Path -LiteralPath $envPath)) { throw 'Создайте .env по .env.example' }
New-Item -ItemType Directory -Force -Path $installDirectory | Out-Null
$launcherPath = Join-Path $installDirectory 'launch.ps1'
$nodeLiteral = $nodePath.Replace("'", "''")
$envLiteral = $envPath.Replace("'", "''")
$mainLiteral = $mainPath.Replace("'", "''")
$launcher = @'
param([string]$Invite = 'pulseparty://launch')
$ErrorActionPreference = 'Stop'
if ($Invite -notmatch '^pulseparty://(launch|join#[A-Za-z0-9_-]{43})$') { exit 2 }
$launchArgs = @('"--env-file=ENV_PATH"', '"MAIN_PATH"', '--join', ('"' + $Invite + '"'))
Start-Process -FilePath 'NODE_PATH' -ArgumentList $launchArgs -WindowStyle Hidden
'@
$launcher = $launcher.Replace('NODE_PATH', $nodeLiteral).Replace('ENV_PATH', $envLiteral).Replace('MAIN_PATH', $mainLiteral)
Set-Content -LiteralPath $launcherPath -Value $launcher -Encoding utf8
New-Item -Path "$protocolKey\shell\open\command" -Force | Out-Null
Set-Item -LiteralPath $protocolKey -Value 'URL:PulseParty'
New-ItemProperty -LiteralPath $protocolKey -Name 'URL Protocol' -Value '' -Force | Out-Null
$command = 'powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $launcherPath + '" -Invite "%1"'
Set-Item -LiteralPath "$protocolKey\shell\open\command" -Value $command
if ($AutoStart) {
    $startCommand = 'powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $launcherPath + '"'
    New-ItemProperty -LiteralPath $runKey -Name 'PulseParty' -Value $startCommand -Force | Out-Null
}
Write-Host 'Схема pulseparty:// зарегистрирована для текущего пользователя. Запустите npm run start:companion для сопряжения.'
