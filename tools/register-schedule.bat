@echo off
cd /d "%~dp0"

:: Resin OpenAI Pipeline - Windows Task Scheduler registration
:: Run as Administrator to register/unregister the hourly task

set TASK_NAME=Resin-OpenAI-Pipeline
set SCRIPT_PATH=%~dp0run-openai-pipeline.bat

if "%~1"=="remove" goto :remove
if "%~1"=="status" goto :status

echo Registering scheduled task: %TASK_NAME%
echo Script: %SCRIPT_PATH%
echo Schedule: Every 1 hour

schtasks /create /tn "%TASK_NAME%" /tr "\"%SCRIPT_PATH%\"" /sc hourly /mo 1 /st 00:00 /f /rl highest

if %errorlevel% equ 0 (
    echo.
    echo Task registered successfully!
    echo Run 'register-schedule.bat status' to check, or 'register-schedule.bat remove' to uninstall.
) else (
    echo.
    echo Failed to register. Try running as Administrator.
)
goto :eof

:remove
echo Removing scheduled task: %TASK_NAME%
schtasks /delete /tn "%TASK_NAME%" /f
if %errorlevel% equ 0 (echo Removed.) else (echo Task not found or failed to remove.)
goto :eof

:status
schtasks /query /tn "%TASK_NAME%" /v /fo list 2>nul
if %errorlevel% neq 0 echo Task '%TASK_NAME%' is not registered.
goto :eof
