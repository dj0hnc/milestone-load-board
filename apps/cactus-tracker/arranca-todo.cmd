@echo off
REM ============================================================
REM  ARRANCA-TODO - Milestone Texas Tracker (self-hosted / ngrok)
REM  Levanta servidor + repartidor + tunel ngrok, cada uno en su
REM  ventana y con auto-reinicio si se cae.
REM ============================================================
title Arranca-todo Milestone Tracker
cd /d "%~dp0"

echo Actualizando codigo (si hay internet)...
git pull 2>nul

if not exist node_modules (
  echo Instalando dependencias (solo la primera vez)...
  call npm install --no-audit --no-fund
)

echo Levantando servidor, repartidor y ngrok...
start "Milestone Tracker 8791" /min cmd /k run-tracker.cmd
start "Repartidor 8000" /min cmd /k run-proxy.cmd
start "ngrok" /min cmd /k run-ngrok.cmd

echo.
echo  ============================================================
echo   LISTO. Tres ventanas minimizadas trabajando (se reinician solas).
echo   Tracker:   https://bullion-magician-prancing.ngrok-free.dev/cactus-tracker/
echo   Otro tool: https://bullion-magician-prancing.ngrok-free.dev/
echo  ============================================================
echo   Puedes cerrar ESTA ventana; las otras 3 siguen trabajando.
timeout /t 8 >nul
