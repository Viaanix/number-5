@echo off
rem Windows entry point for the docker-agent-workflows launcher (launcher\src\cli.ts).
rem The POSIX equivalent is bin/daw. PowerShell users get a profile function from the
rem installer that calls bun directly; this file serves cmd.exe and anything that
rem resolves commands through PATHEXT.
setlocal
set "DAW_REPOSITORY_ROOT=%~dp0.."
where bun >nul 2>nul
if errorlevel 1 (
  echo daw: bun is not installed ^(https://bun.sh^) 1>&2
  exit /b 1
)
if not exist "%DAW_REPOSITORY_ROOT%\node_modules" (
  echo daw: dependencies are missing; run: bun install --cwd "%DAW_REPOSITORY_ROOT%" 1>&2
  exit /b 1
)
bun "%DAW_REPOSITORY_ROOT%\launcher\src\cli.ts" %*
exit /b %ERRORLEVEL%
