@echo off
rem Windows entry point for the number-5 launcher (launcher\src\cli.ts).
rem The POSIX equivalent is bin/j5. PowerShell users get a profile function from the
rem installer that calls bun directly; this file serves cmd.exe and anything that
rem resolves commands through PATHEXT.
setlocal
set "J5_REPOSITORY_ROOT=%~dp0.."
where bun >nul 2>nul
if errorlevel 1 (
  echo j5: bun is not installed ^(https://bun.sh^) 1>&2
  exit /b 1
)
if not exist "%J5_REPOSITORY_ROOT%\node_modules" (
  echo j5: dependencies are missing; run: bun install --cwd "%J5_REPOSITORY_ROOT%" 1>&2
  exit /b 1
)
bun "%J5_REPOSITORY_ROOT%\launcher\src\cli.ts" %*
exit /b %ERRORLEVEL%
