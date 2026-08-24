@echo off
REM ============================================================
REM  ARRANCA-TODO - Milestone Texas OS (office = produccion)
REM  Tracker (8791) + repartidor (8000) + ngrok (dominio pagado),
REM  cada uno en su ventana minimizada con auto-reinicio.
REM  El BOARD (8090) lo revive el guardian del tracker solo, con
REM  su env de OneDrive (session-env.json) — no se arranca aqui.
REM ============================================================
title Arranca-todo Milestone TX OS
cd /d "%~dp0"

echo Actualizando codigo si hay internet...
git pull 2>nul

if not exist node_modules call npm install --no-audit --no-fund

echo Levantando tracker, repartidor y ngrok...
start "Milestone Tracker 8791" /min cmd /k run-tracker.cmd
start "Repartidor 8000" /min cmd /k run-proxy.cmd
start "ngrok" /min cmd /k run-ngrok.cmd

echo.
echo  ============================================================
echo   LISTO. Tres ventanas minimizadas trabajando; se reinician
echo   solas. El board (8090) lo levanta el tracker en ~2 min.
echo   Board:    https://milestonetx-os.ngrok.app/full
echo   Tracker:  https://milestonetx-os.ngrok.app/cactus-tracker/
echo  ============================================================
echo   Puedes cerrar ESTA ventana; las otras siguen trabajando.
timeout /t 8 >nul
