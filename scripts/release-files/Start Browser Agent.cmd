@echo off
title Browser Agent server
rem Starts the Browser Agent server. Keep this window open while you use the agent.
rem Running it again restarts the agent: a server that is already running is replaced.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Browser Agent needs Node.js 20 or newer.
  echo  Download it from https://nodejs.org/ ^(the LTS version^), install it, then run this again.
  echo.
  start "" https://nodejs.org/
  pause
  exit /b 1
)
node server.mjs
if errorlevel 1 (
  echo.
  echo The agent server stopped with an error - see the messages above.
  pause
)
