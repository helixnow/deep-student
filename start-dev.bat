@echo off
title Deep Student - AI错题管理系统 开发环境
echo.
echo ================================================
echo     Deep Student - AI错题管理系统
echo     AI Mistake Management System
echo ================================================
echo.
echo 正在启动开发环境...
echo Starting development environment...
echo.

REM 检查是否存在node_modules
if not exist "node_modules" (
    echo 检测到缺少依赖包，正在自动安装...
    echo Missing dependencies detected, installing...
    echo.
    npm install
    echo.
)

REM 检查是否存在src-tauri/target目录，如果不存在说明是首次运行
if not exist "src-tauri\target" (
    echo 检测到首次运行，正在初始化Rust环境...
    echo First run detected, initializing Rust environment...
    echo 这可能需要几分钟时间，请耐心等待...
    echo This may take a few minutes, please be patient...
    echo.
)

echo 启动Tauri开发服务器...
echo Starting Tauri development server...
echo.
echo 提示: 开发服务器启动后将自动打开应用窗口
echo Tip: The application window will open automatically after the dev server starts
echo.
echo 按 Ctrl+C 可以停止开发服务器
echo Press Ctrl+C to stop the development server
echo.

REM 启动开发服务器
npm run tauri dev

echo.
echo 开发服务器已停止
echo Development server stopped
echo.
pause