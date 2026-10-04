@echo off
chcp 65001 >nul
setlocal
rem ============================================================
rem  Sync the static Xin Kou Nan Kai build into this repo.
rem  SRC = E:\AI\Marvis\作品\心口难开\web   (edited here)
rem  DST = <this folder>\xinkou-nankai      (portal copy)
rem  Usage: double-click to sync, or run with argument nopause.
rem ============================================================
set "SRC=E:\AI\Marvis\作品\心口难开\web"
set "DST=%~dp0xinkou-nankai"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$src='%SRC%'; $dst='%DST%'; if(-not (Test-Path (Join-Path $src 'index.html'))){Write-Host '[ERROR] source not found:' $src -ForegroundColor Red; exit 1}; New-Item -ItemType Directory -Force -Path $dst | Out-Null; foreach($f in @('index.html','app.js','engine.js','style.css')){Copy-Item (Join-Path $src $f) (Join-Path $dst $f) -Force}; foreach($d in @('vendor','data')){Copy-Item (Join-Path $src $d) $dst -Recurse -Force}; Write-Host '[OK] synced to:' $dst -ForegroundColor Green; Write-Host '[OK] source   :' $src"

echo.
if /i not "%~1"=="nopause" pause
endlocal
