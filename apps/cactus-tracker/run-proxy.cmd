@echo off
REM Repartidor por ruta (puerto 8000): /cactus-tracker -> 8791, resto -> 8090.
REM Se reinicia solo si se cae.
cd /d "%~dp0"
:loop
node proxy.js
echo.
echo [proxy] se detuvo, reiniciando en 3s... Ctrl+C para salir
timeout /t 3 /nobreak >nul
goto loop
