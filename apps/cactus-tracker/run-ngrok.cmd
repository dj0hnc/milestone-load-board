@echo off
REM Tunel ngrok -> proxy (8000), en el dominio fijo. Se reconecta solo si se cae.
:loop
ngrok http 8000 --url=https://bullion-magician-prancing.ngrok-free.dev
echo.
echo [ngrok] se detuvo, reintentando en 5s...  (Ctrl+C para salir)
timeout /t 5 /nobreak >nul
goto loop
