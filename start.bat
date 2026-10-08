@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo GitVisor starting ...
echo Open: http://127.0.0.1:4590
start "" http://127.0.0.1:4590
node server.js
pause
