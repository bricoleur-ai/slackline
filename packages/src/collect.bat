@echo off
cd /d "%~dp0"
if not exist node_modules ( echo Installing deps first run... & call npm install --no-audit --no-fund & call npx playwright install chromium )
node collector.mjs %*
