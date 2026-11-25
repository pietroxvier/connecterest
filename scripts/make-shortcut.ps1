# Cria o atalho "Lookbook" no Desktop apontando para o Electron do projeto.
# Sem instalador, sem .exe próprio: o atalho chama o electron.exe com a pasta do app.
# Rode de novo se mover a pasta do projeto.
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$electron = Join-Path $root "node_modules\electron\dist\electron.exe"
$icon = Join-Path $root "assets\icon.ico"

if (-not (Test-Path $electron)) {
    throw "Electron nao encontrado em $electron. Rode: node node_modules/electron/install.js"
}
if (-not (Test-Path $icon)) {
    throw "Icone nao encontrado em $icon. Rode: npx electron scripts/make-icon.js"
}

$desktop = [Environment]::GetFolderPath("Desktop")
$shortcut = Join-Path $desktop "Lookbook.lnk"

$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($shortcut)
$sc.TargetPath = $electron
$sc.Arguments = '"' + $root + '"'
$sc.WorkingDirectory = $root
$sc.IconLocation = "$icon,0"
$sc.Description = "Lookbook - looks do Pinterest por estetica"
$sc.WindowStyle = 1
$sc.Save()

Write-Output "atalho criado: $shortcut"
Write-Output "destino: $electron `"$root`""