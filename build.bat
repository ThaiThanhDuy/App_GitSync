@echo off
rem Build file cai dat cho Windows. Bam dup hoac chay: build.bat [--version 1.2.0]
cd /d "%~dp0"
node scripts\build.js win %*
if errorlevel 1 (
  echo.
  echo Build failed.
)
echo.
pause
