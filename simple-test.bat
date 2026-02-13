@echo off
echo 测试Windows编译环境...
echo.

echo 1. 检查Rust...
rustc --version
if %errorlevel% neq 0 (
    echo 错误：Rust未安装
    exit /b 1
)

echo 2. 检查Node.js...
node --version
if %errorlevel% neq 0 (
    echo 错误：Node.js未安装
    exit /b 1
)

echo 3. 检查项目结构...
if not exist "src-tauri\Cargo.toml" (
    echo 错误：未找到Cargo.toml
    exit /b 1
)
if not exist "package.json" (
    echo 错误：未找到package.json
    exit /b 1
)
echo 项目结构正常

echo 4. 快速编译检查...
cd src-tauri
echo 运行 cargo check...
cargo check
if %errorlevel% eq 0 (
    echo 编译检查通过！
) else (
    echo 编译检查失败！
    cd ..
    exit /b 1
)
cd ..

echo.
echo 测试完成 - Windows编译环境正常！