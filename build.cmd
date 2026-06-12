@echo off
REM Build the portable .exe from a clean (space/&-free) path. See BUILD.md.
setlocal
set "SRC=%~dp0"
set "BUILD=%USERPROFILE%\milestone-build"

REM Prefer the portable Node bundled under _milestone_work; else use Node on PATH.
set "LOCALNODE=%SRC%..\_milestone_work\toolchain\node-v24.16.0-win-x64"
if exist "%LOCALNODE%\node.exe" set "PATH=%LOCALNODE%;%PATH%"

where node >nul 2>nul || (echo [!] Node not found. Install Node.js or restore _milestone_work\toolchain. & exit /b 1)
for /f "delims=" %%v in ('node --version') do echo Using Node %%v

echo Copying source to clean path: %BUILD%
if exist "%BUILD%" rmdir /s /q "%BUILD%"
robocopy "%SRC%." "%BUILD%" /E /XD node_modules dist dist-pkg .board-backups >nul

pushd "%BUILD%"
echo Installing deps...
call npm install --no-audit --no-fund || (echo npm install failed & popd & exit /b 1)
echo Building portable exe...
set "CSC_IDENTITY_AUTO_DISCOVERY=false"
call node_modules\.bin\electron-builder.cmd --win portable --x64 || (echo build failed & popd & exit /b 1)
popd

echo Copying artifact back...
if not exist "%SRC%dist" mkdir "%SRC%dist"
copy /y "%BUILD%\dist\MilestoneLoadBoard-2.0.0-portable.exe" "%SRC%dist\" >nul
echo.
echo DONE -> %SRC%dist\MilestoneLoadBoard-2.0.0-portable.exe
endlocal
