@echo off
REM ============================================================
REM  ARRANCA-TODO — Milestone Texas Tracker (self-hosted / ngrok)
REM  Levanta solo: servidor + repartidor + tunel ngrok.
REM  Cada uno en su ventana y se reinicia solo si se cae.
REM  Doble click a este archivo (o corre solo al prender la PC
REM  si instalaste el auto-arranque).
REM ============================================================
title Arranca-todo Milestone Tracker
cd /d "%~dp0"

echo Actualizando codigo (si hay internet)...
git pull 2>nul

if not exist node_modules (
  echo Instalando dependencias (solo la primera vez)...
  call npm install --no-audit --no-fund
)

REM PIN de equipo (solo lo crea si no existe; no pisa tu config)
if not exist "data" mkdir data
if not exist "data\config.json" (
  >"data\config.json" echo {"accessPin":"2585"}
)

echo Levantando servidor, repartidor y ngrok...
start "Milestone Tracker (8791)" /min cmd /k run-tracker.cmd
start "Repartidor (8000)"        /min cmd /k run-proxy.cmd
start "ngrok"                    /min cmd /k run-ngrok.cmd

echo.
echo  ============================================================
echo   LISTO. Todo corriendo (3 ventanas minimizadas).
echo   Tracker:  https://bullion-magician-prancing.ngrok-free.dev/cactus-tracker/
echo   Otro tool: https://bullion-magician-prancing.ngrok-free.dev/
echo   (El "otro tool" en :8090 arranca por su cuenta, no lo maneja esto.)
echo  ============================================================
echo.
echo  Puedes cerrar ESTA ventana. Las otras 3 quedan trabajando.
timeout /t 8 >nul
