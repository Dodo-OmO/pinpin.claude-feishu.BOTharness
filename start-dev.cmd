@echo off
chcp 65001 >nul
REM 启动品品 Electron 启动器（开发模式）。从脚本所在目录运行，无需改路径。
cd /d "%~dp0"
call npm run launcher:dev
pause
