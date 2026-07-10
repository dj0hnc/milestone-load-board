@echo off
REM ============================================================
REM  CACTUS TRACKER - arrancador de doble click (Windows)
REM  1er uso: instala dependencias y carga el roster solo.
REM  Deja esta ventana abierta: ella ES el servidor.
REM ============================================================
title Cactus Tracker
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [X] Falta Node.js. Descargalo de https://nodejs.org (version LTS 22 o mas)
  echo      instalalo con todo por default y vuelve a dar doble click aqui.
  echo.
  pause
  exit /b 1
)

for /f "tokens=1 delims=v." %%a in ('node -v') do set NODEMAJOR=%%a
if %NODEMAJOR% LSS 22 (
  echo.
  echo  [X] Tu Node.js es viejo ^(se necesita 22+^). Actualiza en https://nodejs.org
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo  Instalando dependencias ^(solo la primera vez^)...
  call npm install --no-audit --no-fund
)

echo.
echo  ============================================
echo   CACTUS TRACKER corriendo.
echo   En esta PC:    http://localhost:8791/cactus-tracker/
echo   NO CIERRES esta ventana (es el servidor).
echo  ============================================
echo.

start "" "http://localhost:8791/cactus-tracker/"
node server\index.js
echo.
echo  El servidor se detuvo.
pause
