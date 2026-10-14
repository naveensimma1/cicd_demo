@echo off
cd /d "%~dp0"
set "NODEEXE="
where node >nul 2>&1 && set "NODEEXE=node"
if not defined NODEEXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODEEXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODEEXE if exist "%LocalAppData%\Programs\node\node.exe" set "NODEEXE=%LocalAppData%\Programs\node\node.exe"
if not defined NODEEXE (
  echo Node.js 18 or newer was not found.
  echo Install the LTS build from https://nodejs.org/en/download
  echo Then close this window and run start-concierto-cicd.bat again.
  pause
  exit /b 1
)
echo.
echo Starting Concierto CI/CD. Leave this window open.
echo.
"%NODEEXE%" server.js
echo.
echo Server stopped.
pause
