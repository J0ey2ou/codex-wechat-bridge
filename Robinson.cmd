@echo off
cd /d "%~dp0"
node scripts\robinson.mjs
if errorlevel 1 pause
