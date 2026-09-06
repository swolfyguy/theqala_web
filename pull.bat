@echo off
REM ---------------------------------------------------------------------------
REM  The Qala - bring this folder up to date with GitHub.
REM
REM  Run on its own, or called by dev.bat and preview.bat before they start,
REM  so you are never working on yesterday's copy of the shop.
REM
REM  It will never throw anything away. If the pull cannot be done cleanly it
REM  says why and leaves your files exactly as they are.
REM ---------------------------------------------------------------------------

setlocal
cd /d "%~dp0"

where git >NUL 2>NUL || (
  echo   [ skipped ] Git is not installed on this computer, so there is nothing to pull.
  exit /b 0
)
if not exist ".git" (
  echo   [ skipped ] This folder is not a copy of the repository, so there is nothing to pull.
  exit /b 0
)

echo.
echo   Checking GitHub for anything new...

REM  --ff-only means: only move forward. If the branch has genuinely moved
REM  apart, git stops and says so rather than making a merge behind your back.
git pull --ff-only
if errorlevel 1 goto :nope

echo   Up to date.
echo.
exit /b 0

:nope
echo.
echo   ------------------------------------------------------------------
echo   Could not pull. NOTHING WAS CHANGED and nothing was lost - the
echo   server below will start with the files you have here now.
echo.
echo   The usual reasons, in order of likelihood:
echo.
echo     * No internet.
echo.
echo     * You have changes here that are not committed yet, and the
echo       incoming changes touch the same files. Run:  git status
echo       Commit or stash yours, then run pull.bat again.
echo.
echo     * Someone pushed something that does not sit on top of what you
echo       have. That needs a real merge, by hand.
echo.
echo     * A leftover .git\index.lock from a git that was interrupted.
echo       If you are certain no git is running, delete that one file.
echo   ------------------------------------------------------------------
echo.
timeout /t 6 >NUL
exit /b 0
