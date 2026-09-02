@echo off
rem vorno-cli — fork(PLAN-049). See the POSIX wrapper for the resolution order.
if not "%CRAFT_VORNO_CLI_BIN%"=="" if exist "%CRAFT_VORNO_CLI_BIN%" (
  "%CRAFT_VORNO_CLI_BIN%" %*
  exit /b %ERRORLEVEL%
)
if exist "%~dp0vorno-cli.exe" (
  "%~dp0vorno-cli.exe" %*
  exit /b %ERRORLEVEL%
)
set "CRAFT_BUN_BIN=%CRAFT_BUN%"
if "%CRAFT_BUN_BIN%"=="" set "CRAFT_BUN_BIN=bun"
if not "%CRAFT_CLI_ENTRY%"=="" if exist "%CRAFT_CLI_ENTRY%" (
  "%CRAFT_BUN_BIN%" run "%CRAFT_CLI_ENTRY%" %*
  exit /b %ERRORLEVEL%
)
echo vorno-cli: no runnable CLI found. 1>&2
exit /b 127
