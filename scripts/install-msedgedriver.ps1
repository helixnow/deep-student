<# 
.SYNOPSIS
    安装与当前 Microsoft Edge 版本匹配的 Edge WebDriver
    
.DESCRIPTION
    此脚本自动检测已安装的 Edge 版本，下载对应的 msedgedriver.exe，
    并将其添加到系统 PATH 中，用于 Tauri E2E 测试。

.NOTES
    运行方式: powershell -ExecutionPolicy Bypass -File scripts/install-msedgedriver.ps1
    
.LINK
    https://v2.tauri.app/develop/tests/webdriver/
#>

$ErrorActionPreference = "Stop"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Microsoft Edge WebDriver 安装脚本" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 1. 检测 Edge 版本
Write-Host "[1/5] 检测 Microsoft Edge 版本..." -ForegroundColor Yellow

$edgePath = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path $edgePath)) {
    $edgePath = "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
}

if (-not (Test-Path $edgePath)) {
    Write-Error "未找到 Microsoft Edge，请先安装 Edge 浏览器"
    exit 1
}

$edgeVersion = (Get-Item $edgePath).VersionInfo.ProductVersion
Write-Host "  Edge 版本: $edgeVersion" -ForegroundColor Green

# 2. 确定下载目录
Write-Host "[2/5] 准备下载目录..." -ForegroundColor Yellow

$downloadDir = "$env:USERPROFILE\.msedgedriver"
if (-not (Test-Path $downloadDir)) {
    New-Item -ItemType Directory -Path $downloadDir -Force | Out-Null
}
Write-Host "  下载目录: $downloadDir" -ForegroundColor Green

# 3. 下载 Edge Driver
Write-Host "[3/5] 下载 msedgedriver..." -ForegroundColor Yellow

$driverUrl = "https://msedgedriver.azureedge.net/$edgeVersion/edgedriver_win64.zip"
$zipPath = "$downloadDir\edgedriver.zip"

try {
    Write-Host "  下载 URL: $driverUrl"
    
    # 使用 WebClient 下载（更可靠）
    $webClient = New-Object System.Net.WebClient
    $webClient.DownloadFile($driverUrl, $zipPath)
    
    Write-Host "  下载完成" -ForegroundColor Green
}
catch {
    Write-Host "  主下载失败，尝试使用 cargo 工具..." -ForegroundColor Yellow
    
    # 备用方案：使用 msedgedriver-tool
    Write-Host "  安装 msedgedriver-tool..."
    cargo install --git https://github.com/chippers/msedgedriver-tool --force
    
    $msedgedriverToolPath = "$env:USERPROFILE\.cargo\bin\msedgedriver-tool.exe"
    if (Test-Path $msedgedriverToolPath) {
        & $msedgedriverToolPath
        $downloadDir = Split-Path -Parent $msedgedriverToolPath
    }
    else {
        Write-Error "msedgedriver-tool 安装失败"
        exit 1
    }
}

# 4. 解压并安装
Write-Host "[4/5] 解压 msedgedriver..." -ForegroundColor Yellow

if (Test-Path $zipPath) {
    Expand-Archive -Path $zipPath -DestinationPath $downloadDir -Force
    Remove-Item $zipPath -Force
    
    $driverPath = "$downloadDir\msedgedriver.exe"
    if (Test-Path $driverPath) {
        Write-Host "  msedgedriver 位置: $driverPath" -ForegroundColor Green
    }
    else {
        Write-Error "解压后未找到 msedgedriver.exe"
        exit 1
    }
}

# 5. 添加到 PATH
Write-Host "[5/5] 配置环境变量..." -ForegroundColor Yellow

$currentPath = [Environment]::GetEnvironmentVariable("PATH", "User")
if ($currentPath -notlike "*$downloadDir*") {
    [Environment]::SetEnvironmentVariable("PATH", "$currentPath;$downloadDir", "User")
    Write-Host "  已添加到用户 PATH" -ForegroundColor Green
    Write-Host "  注意: 请重新打开终端以使 PATH 生效" -ForegroundColor Yellow
}
else {
    Write-Host "  目录已在 PATH 中" -ForegroundColor Green
}

# 临时添加到当前会话
$env:PATH = "$env:PATH;$downloadDir"

# 验证安装
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  安装验证" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

$msedgedriverExe = Get-Command msedgedriver -ErrorAction SilentlyContinue
if ($msedgedriverExe) {
    Write-Host "msedgedriver 路径: $($msedgedriverExe.Source)" -ForegroundColor Green
    
    # 获取版本
    $driverVersion = & msedgedriver --version 2>&1
    Write-Host "msedgedriver 版本: $driverVersion" -ForegroundColor Green
}
else {
    Write-Host "警告: msedgedriver 未在 PATH 中找到" -ForegroundColor Yellow
    Write-Host "请手动将 $downloadDir 添加到 PATH" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  安装完成!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "下一步:" -ForegroundColor Yellow
Write-Host "  1. 安装 tauri-driver: cargo install tauri-driver --locked" -ForegroundColor White
Write-Host "  2. 安装测试依赖: npm run test:tauri:install" -ForegroundColor White
Write-Host "  3. 运行 E2E 测试: npm run test:tauri" -ForegroundColor White
Write-Host ""
