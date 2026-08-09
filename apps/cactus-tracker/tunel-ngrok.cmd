@echo off
REM ============================================================
REM  TUNEL NGROK - Milestone Texas Tracker
REM  Corre esto EN OTRA VENTANA, con el tracker YA corriendo
REM  (start-tracker.cmd abierto). Te da una URL publica https que
REM  abres en el cel y compartes al equipo.
REM
REM  Requiere ngrok instalado y con authtoken puesto una vez:
REM     ngrok config add-authtoken TU_TOKEN
REM  (el mismo token que ya usan para el otro tool)
REM ============================================================
title Tunel ngrok - Milestone Tracker
cd /d "%~dp0"

where ngrok >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [X] Falta ngrok. Instalalo con:
  echo      winget install ngrok.ngrok
  echo      ^(o descargalo de https://ngrok.com/download^)
  echo  Luego pon tu token una vez:  ngrok config add-authtoken TU_TOKEN
  echo.
  pause
  exit /b 1
)

echo.
echo  Creando tunel ngrok hacia http://localhost:8791 ...
echo  La URL publica ( https://XXXX.ngrok-free.app ) aparece abajo como "Forwarding".
echo  Abrela en el cel y agregale al final:  /cactus-tracker/
echo  NO CIERRES esta ventana (es el tunel).
echo.

REM Si tienes un DOMINIO RESERVADO en ngrok (URL fija), usa la linea de abajo
REM en vez de la siguiente, cambiando tu-dominio:
REM   ngrok http --domain=tu-dominio.ngrok-free.app 8791
ngrok http 8791
pause
