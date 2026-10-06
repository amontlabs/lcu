@echo off
rem LCU release launcher: delegates to the installation's validating launcher <prefix>\lcu.cmd (three levels up,
rem <prefix>\releases\<release>\bin), which checks the private Node before running it.
if not exist "%~dp0..\..\..\lcu.cmd" (
  >&2 echo LCU: this release is not installed under an LCU prefix; run the LCU installer first.
  exit /b 1
)
call "%~dp0..\..\..\lcu.cmd" %*
exit /b %ERRORLEVEL%
