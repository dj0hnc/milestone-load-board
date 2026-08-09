@echo off
REM Servidor del tracker (puerto 8791). Se reinicia solo si se cae.
cd /d "%~dp0"
:loop
node server\index.js
echo.
echo [tracker] se detuvo, reiniciando en 3s... Ctrl+C para salir
timeout /t 3 /nobreak >nul
goto loop
