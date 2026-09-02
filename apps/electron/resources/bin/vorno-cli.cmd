@echo off
rem vorno-cli — fork(PLAN-049). See the POSIX wrapper for the resolution order.
rem
rem Uses goto labels rather than parenthesized if-blocks on purpose. Inside a
rem `if (...)` block cmd.exe expands %ERRORLEVEL% at PARSE time, before the
rem command on the preceding line has run, so `exit /b %ERRORLEVEL%` returns a
rem stale value. Labels sidestep that entirely and need no delayed expansion.
setlocal

if "%CRAFT_VORNO_CLI_BIN%"=="" goto :try_sibling
if not exist "%CRAFT_VORNO_CLI_BIN%" goto :try_sibling
"%CRAFT_VORNO_CLI_BIN%" %*
goto :done

:try_sibling
if not exist "%~dp0vorno-cli-bin.exe" goto :try_entry
"%~dp0vorno-cli-bin.exe" %*
goto :done

:try_entry
if "%CRAFT_CLI_ENTRY%"=="" goto :not_found
if not exist "%CRAFT_CLI_ENTRY%" goto :not_found
set "CRAFT_BUN_BIN=%CRAFT_BUN%"
if "%CRAFT_BUN_BIN%"=="" set "CRAFT_BUN_BIN=bun"
"%CRAFT_BUN_BIN%" run "%CRAFT_CLI_ENTRY%" %*
goto :done

:not_found
echo vorno-cli: no runnable CLI found. 1>&2
echo   Looked for: %%CRAFT_VORNO_CLI_BIN%%, %~dp0vorno-cli-bin.exe, %%CRAFT_CLI_ENTRY%% 1>&2
echo   In a dev checkout run: bun run scripts/build-cli.ts 1>&2
endlocal
exit /b 127

:done
endlocal & exit /b %ERRORLEVEL%
