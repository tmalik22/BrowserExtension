@echo off
title Browser Agent server
rem Starts the Browser Agent server. Keep this window open while you use the agent.
rem Running it again restarts the agent: a server that is already running is replaced.
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install || goto :fail
)
if not exist packages\extension\dist\manifest.json (
  echo Building the Chrome extension...
  call npm run build:ext || goto :fail
)
echo.
echo  Extension folder for Chrome (Load unpacked):
echo    %~dp0packages\extension\dist
echo.
call npm run server || goto :fail
goto :eof
:fail
echo.
echo The agent server stopped with an error - see the messages above.
pause
