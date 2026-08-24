@echo off
REM Tunel ngrok -> proxy (8000), dominio fijo PAGADO. Se reconecta solo si se cae.
REM Si otro agente ya tiene el dominio (laptop de respaldo activa), ngrok truena y este
REM loop reintenta cada 15s — asi la office toma el dominio sola en cuanto se libere.
:loop
ngrok http --url=milestonetx-os.ngrok.app 8000
echo.
echo [ngrok] se detuvo, reintentando en 15s... Ctrl+C para salir
timeout /t 15 /nobreak >nul
goto loop
