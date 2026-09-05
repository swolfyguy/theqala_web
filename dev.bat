@echo off
REM  The Qala - run the whole website on this computer, the way it behaves
REM  on Cloudflare: the shop, the order form, the database and the order book.
REM  Double-click this file, then open http://localhost:8788
REM  Press Ctrl+C in this window to stop.

setlocal
cd /d "%~dp0"

where node >NUL 2>NUL || (
  echo.
  echo   Node is not installed on this computer. Get it from https://nodejs.org
  echo   then run this file again.
  echo.
  pause
  exit /b 1
)

REM  The sign-in password while testing here. Not the real one - this file is
REM  in the repository. Change the line below if you want a different one.
set "STUDIO_PASSWORD=qala-dev"

start "" "http://localhost:8788/"
node dev.mjs
pause
