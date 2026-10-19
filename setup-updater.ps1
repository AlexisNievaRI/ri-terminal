# Genera la clave de firma y deja configurado el actualizador (clave publica + repo de GitHub).
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$utf8 = New-Object System.Text.UTF8Encoding $false
$keyDir = Join-Path $env:USERPROFILE '.tauri'
New-Item -ItemType Directory -Force $keyDir | Out-Null
$key = Join-Path $keyDir 'ri-terminal.key'

if (Test-Path $key) {
  Write-Host "Ya existe una clave de firma en $key (se reutiliza)." -ForegroundColor Yellow
} else {
  Write-Host 'Se va a generar la clave de firma. Te pedira una contrasena: anotala, la vas a necesitar.' -ForegroundColor Cyan
  npx tauri signer generate -w $key
  if (-not (Test-Path $key)) { throw 'No se genero la clave.' }
}
$pub = (Get-Content "$key.pub" -Raw).Trim()

$repo = Read-Host 'Repositorio de GitHub (usuario/repositorio, ej. juanperez/ri-terminal)'
if ($repo -notmatch '^[\w.-]+/[\w.-]+$') { throw 'Formato invalido. Debe ser usuario/repositorio.' }

$confPath = Join-Path $PSScriptRoot 'src-tauri\tauri.conf.json'
$c = [IO.File]::ReadAllText($confPath)
$url = "https://github.com/$repo/releases/latest/download/latest.json"
$c = $c -replace '("pubkey":\s*")[^"]*(")', ('${1}' + $pub + '${2}')
$c = $c -replace '("endpoints":\s*\[\s*")[^"]*(")', ('${1}' + $url + '${2}')
[IO.File]::WriteAllText($confPath, $c, $utf8)

Get-Content $key -Raw | Set-Clipboard
Write-Host "`nListo. tauri.conf.json quedo con tu clave publica y el repo $repo." -ForegroundColor Green
Write-Host "La clave PRIVADA ya esta copiada en el portapapeles. Ahora:" -ForegroundColor Cyan
Write-Host "  1) GitHub > tu repo > Settings > Secrets and variables > Actions > New repository secret"
Write-Host "  2) Nombre: TAURI_SIGNING_PRIVATE_KEY   Valor: pega el portapapeles (Ctrl+V)"
Write-Host "  3) Otro secreto: TAURI_SIGNING_PRIVATE_KEY_PASSWORD con la contrasena que elegiste"
Write-Host "  4) Guarda una copia de $key en un lugar seguro (si la pierdes, las instalaciones no podran actualizarse)."
