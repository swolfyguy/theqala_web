@echo off
REM  The Qala - open the shop and the studio on this computer.
REM  Double-click this file. It serves the site at http://localhost:8000 and
REM  opens the studio, where you can add and delete photographs. Everything is
REM  written straight into the photos folder next to this file.
REM  Press Ctrl+C in this window to stop.

setlocal
cd /d "%~dp0"

set "PY=python"
where python >NUL 2>NUL || set "PY=py -3"

%PY% -c "import PIL" >NUL 2>NUL || (
  echo.
  echo   Pillow is not installed. Photos will still work, but they cannot be
  echo   shrunk automatically and iPhone .heic files cannot be read. To fix:
  echo.
  echo       %PY% -m pip install pillow pillow-heif
  echo.
  pause
)

if exist "studio.py" (
  %PY% studio.py
  goto :done
)

REM  fallback: no studio server, just the shop
%PY% build_catalogue.py --optimize
if errorlevel 1 (
  echo.
  echo   Something went wrong above. Fix it, then run this again.
  pause
  exit /b 1
)
start "" "http://localhost:8000"
%PY% -m http.server 8000

:done
