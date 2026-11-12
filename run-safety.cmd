@echo off
rem 🦺 Safe Dumping app — loop de vida: si el server sale (self-update o error), se relanza.
cd /d "%~dp0"
:loop
git pull --ff-only origin safety-roadrunner 1>nul 2>nul
node server.js
timeout /t 5 /nobreak >nul
goto loop
