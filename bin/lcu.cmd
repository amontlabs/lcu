@echo off
rem Run the ChatGPT app's own Node on lcu\runtime.mjs. Contract: docs/REMOVE-PYTHON.md, "Launcher contract".
setlocal
set "LCU_NODE_PATH_FILE=%~dp0..\node-path"
set "LCU_RUN_NODE=%LCU_NODE%"
if exist "%LCU_NODE_PATH_FILE%" set /p LCU_RUN_NODE=<"%LCU_NODE_PATH_FILE%"
if not defined LCU_RUN_NODE goto missing
if not exist "%LCU_RUN_NODE%" goto missing
endlocal & "%LCU_RUN_NODE%" "%~dp0..\lcu\runtime.mjs" %*
exit /b %ERRORLEVEL%
:missing
if /i "%~1"=="--help" goto help
if /i "%~1"=="-h" goto help
>&2 echo LCU: the ChatGPT app's Node is not recorded or missing. Repair the ChatGPT app, then reinstall LCU.
exit /b 1
:help
type "%~dp0..\lcu\usage.txt"
exit /b 0
