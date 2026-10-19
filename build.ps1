$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
foreach ($t in 'node','npm','cargo') {
  if (-not (Get-Command $t -ErrorAction SilentlyContinue)) { throw "Falta '$t' en el PATH." }
}
npm install
npx tauri icon app-icon.png
if ($env:TAURI_SIGNING_PRIVATE_KEY) {
  npx tauri build
} else {
  Write-Host "`nSin clave de firma: se compila sin el paquete de actualizacion (sirve para instalar y probar)." -ForegroundColor Yellow
  npx tauri build --config src-tauri/tauri.local.conf.json
}
if ($LASTEXITCODE -ne 0) { throw 'Fallo la compilacion.' }
$exe = Get-ChildItem src-tauri\target\release\bundle\nsis\*.exe | Select-Object -First 1
Write-Host "`nInstalador listo: $($exe.FullName)" -ForegroundColor Green
Start-Process explorer.exe $exe.DirectoryName
