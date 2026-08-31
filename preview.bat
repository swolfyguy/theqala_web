@echo off
REM  The Qala - preview the site on this computer.
REM  Double-click this file. It rebuilds the catalogue from the photos folder,
REM  then serves the site at http://localhost:8000 and opens your browser.
REM  Press Ctrl+C in this window to stop.

setlocal
cd /d "%~dp0"

set "PY=python"
where python >NUL 2>NUL || set "PY=py -3"

%PY% -c "import PIL" >NUL 2>NUL || (
  echo.
  echo   Pillow is not installed. Photos will still show, but the script
  echo   cannot shrink them or read iPhone .heic files. To fix:
  echo.
  echo       %PY% -m pip install pillow pillow-heif
  echo.
)

echo Rebuilding the catalogue...
echo.
%PY% build_catalogue.py --optimize
if errorlevel 1 (
  echo.
  echo   Something went wrong above. Fix it, then run this again.
  pause
  exit /b 1
)

echo.
echo   Opening http://localhost:8000
echo   Leave this window open. Press Ctrl+C here to stop the preview.
echo.
start "" "http://localhost:8000"
%PY% -m http.server 8000
