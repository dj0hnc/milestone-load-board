@echo off
REM ============================================================
REM  Deja el tracker ARRANCANDO SOLO cada vez que prendas la PC.
REM  Crea un acceso directo a arranca-todo.cmd en la carpeta de
REM  Inicio de Windows. Corre esto UNA sola vez.
REM ============================================================
title Instalar auto-arranque
cd /d "%~dp0"

set "TARGET=%~dp0arranca-todo.cmd"
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"

powershell -NoProfile -Command ^
  "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%STARTUP%\MilestoneTracker.lnk');" ^
  "$s.TargetPath='%TARGET%';" ^
  "$s.WorkingDirectory='%~dp0';" ^
  "$s.WindowStyle=7;" ^
  "$s.Description='Milestone Tracker auto-arranque';" ^
  "$s.Save()"

echo.
echo  Listo. El tracker arrancara SOLO cada vez que prendas la PC.
echo  (Se creo el acceso directo en la carpeta de Inicio de Windows.)
echo.
echo  Ahora lo levanto por primera vez...
timeout /t 2 >nul
start "" "%TARGET%"
