@echo off
REM Starts a local web server and opens Neon Pulse in your browser.
REM (The camera only works when the page is served from http://localhost.)
cd /d "%~dp0"
start "" http://localhost:8080
where python >nul 2>nul
if %errorlevel%==0 (
  python -m http.server 8080
) else (
  npx --yes http-server -p 8080 -c-1
)
