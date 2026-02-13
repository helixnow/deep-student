@echo off
REM 检查 R: 盘是否存在
if not exist R:\ (
    echo [ERROR] RAM Disk R: 未挂载，请先启动 ImDisk RAM Disk
    pause
    exit /b 1
)

REM 创建 target 目录
if not exist R:\rust-target\deep-student (
    mkdir R:\rust-target\deep-student
    echo [OK] 已创建 R:\rust-target\deep-student
) else (
    echo [OK] Target 目录已存在
)

echo.
echo RAM Disk 初始化完成！现在可以运行 cargo build
echo.
