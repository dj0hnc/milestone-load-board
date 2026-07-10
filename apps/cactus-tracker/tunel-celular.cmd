@echo off
REM ============================================================
REM  TUNEL PARA EL CELULAR (opcional)
REM  Corre esto EN OTRA VENTANA con el tracker ya corriendo.
REM  Te da una URL https://....trycloudflare.com que abres en el
REM  cel (y la compartes al equipo). Cambia en cada arranque; para
REM  URL fija usa el tunnel con nombre del office bundle.
REM ============================================================
title Tunel Cactus Tracker
cd /d "%~dp0"

where cloudflared >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [X] Falta cloudflared. Instalalo con:
  echo      winget install Cloudflare.cloudflared
  echo      ^(o descargalo de https://github.com/cloudflare/cloudflared/releases^)
  echo.
  pause
  exit /b 1
)

echo  Creando tunel... la URL para el celular aparece abajo:
echo.
cloudflared tunnel --url http://localhost:8791
pause
