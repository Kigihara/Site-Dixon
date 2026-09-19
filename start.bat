@echo off
cd /d "%~dp0"
echo ================================
echo  DIXON backend + site
echo  Site:  http://127.0.0.1:8099/
echo  Admin: http://127.0.0.1:8099/admin.html
echo ================================
node server.js
pause
