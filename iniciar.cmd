@echo off
rem Field Shift: starts the backend and the front end with one double-click.
rem Same as "npm start" inside field-shift-app. Ctrl+C or closing this window stops both.
cd /d "%~dp0field-shift-app"
where node >nul 2>nul || (echo Node.js nao encontrado. Instale em https://nodejs.org e rode de novo. & pause & exit /b 1)
node scripts\start.mjs %*
pause
