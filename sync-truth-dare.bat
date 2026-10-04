@echo off
chcp 65001 >nul
setlocal
rem ============================================================
rem  Sync the static Truth or Dare build into this repo.
rem  SRC   = E:\AI\Marvis\作品\真心话大冒险              (edited here)
rem  DST1  = <this folder>\truth-dare                   (portal standalone copy)
rem  DST2  = <this folder>\number-bomb\truth-dare.js    (quiz bank used by the
rem                                                      in-game penalty layer)
rem  Usage: double-click to sync, or run with argument nopause.
rem ============================================================
set "SRC=E:\AI\Marvis\作品\真心话大冒险"
set "DST=%~dp0truth-dare"
set "BOMB=%~dp0number-bomb"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$src='%SRC%'; $dst='%DST%'; $bomb='%BOMB%'; if(-not (Test-Path (Join-Path $src 'index.html'))){Write-Host '[ERROR] source not found:' $src -ForegroundColor Red; exit 1}; New-Item -ItemType Directory -Force -Path $dst | Out-Null; foreach($f in @('index.html','truth-dare.js')){Copy-Item (Join-Path $src $f) (Join-Path $dst $f) -Force}; if(Test-Path $bomb){Copy-Item (Join-Path $src 'truth-dare.js') (Join-Path $bomb 'truth-dare.js') -Force; Write-Host '[OK] synced to:' (Join-Path $bomb 'truth-dare.js') -ForegroundColor Green}; Write-Host '[OK] synced to:' $dst -ForegroundColor Green; Write-Host '[OK] source   :' $src"

echo.
if /i not "%~1"=="nopause" pause
endlocal
