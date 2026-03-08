# MediaTek MT7921 蓝牙修复脚本
# 此脚本将尝试修复 MT7921 芯片的蓝牙功能

Write-Host "=== MediaTek MT7921 蓝牙修复工具 ===" -ForegroundColor Cyan
Write-Host ""

# 检查管理员权限
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "错误: 此脚本需要管理员权限运行" -ForegroundColor Red
    Write-Host "请右键点击 PowerShell 并选择 '以管理员身份运行'" -ForegroundColor Yellow
    exit 1
}

Write-Host "步骤 1: 检查 MT7921 Wi-Fi 卡状态..." -ForegroundColor Yellow
$wifiCard = Get-PnpDevice | Where-Object {$_.InstanceId -like "*VEN_14C3&DEV_7961*"}
if ($wifiCard) {
    Write-Host "  找到 MT7921 Wi-Fi 卡: $($wifiCard.FriendlyName)" -ForegroundColor Green
    Write-Host "  状态: $($wifiCard.Status)" -ForegroundColor Green
} else {
    Write-Host "  未找到 MT7921 Wi-Fi 卡!" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "步骤 2: 检查现有蓝牙驱动..." -ForegroundColor Yellow
$btDrivers = Get-WindowsDriver -Online | Where-Object {$_.ClassName -eq "Bluetooth"}
if ($btDrivers) {
    Write-Host "  找到 $($btDrivers.Count) 个蓝牙驱动:" -ForegroundColor Green
    $btDrivers | ForEach-Object {
        Write-Host "    - $($_.Driver): $($_.ProviderName) v$($_.Version)" -ForegroundColor Gray
    }
} else {
    Write-Host "  未找到蓝牙驱动" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "步骤 3: 重启 MT7921 设备以触发蓝牙枚举..." -ForegroundColor Yellow
try {
    $deviceId = $wifiCard.InstanceId
    Write-Host "  正在重启设备: $deviceId" -ForegroundColor Gray
    pnputil /restart-device "$deviceId" | Out-Null
    Write-Host "  设备已重启，等待 5 秒..." -ForegroundColor Green
    Start-Sleep -Seconds 5
} catch {
    Write-Host "  重启失败: $_" -ForegroundColor Red
}

Write-Host ""
Write-Host "步骤 4: 扫描硬件更改..." -ForegroundColor Yellow
pnputil /scan-devices | Out-Null
Start-Sleep -Seconds 2

Write-Host ""
Write-Host "步骤 5: 检查蓝牙适配器..." -ForegroundColor Yellow
$btAdapter = Get-PnpDevice -Class Bluetooth -ErrorAction SilentlyContinue | Where-Object {$_.FriendlyName -like "*Adapter*" -or $_.FriendlyName -like "*MediaTek*"}
if ($btAdapter) {
    Write-Host "  找到蓝牙适配器: $($btAdapter.FriendlyName)" -ForegroundColor Green
    Write-Host "  状态: $($btAdapter.Status)" -ForegroundColor Green
    if ($btAdapter.Problem) {
        Write-Host "  问题代码: $($btAdapter.Problem)" -ForegroundColor Red
    }
} else {
    Write-Host "  未找到蓝牙适配器" -ForegroundColor Red
    Write-Host ""
    Write-Host "  可能的原因:" -ForegroundColor Yellow
    Write-Host "  1. BIOS 中蓝牙被禁用" -ForegroundColor Yellow
    Write-Host "  2. 需要从制造商网站下载最新驱动" -ForegroundColor Yellow
    Write-Host "  3. 硬件故障" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "步骤 6: 检查蓝牙服务..." -ForegroundColor Yellow
$bthService = Get-Service -Name "bthserv" -ErrorAction SilentlyContinue
if ($bthService) {
    Write-Host "  蓝牙服务状态: $($bthService.Status)" -ForegroundColor Green
    if ($bthService.Status -ne "Running") {
        Write-Host "  正在启动蓝牙服务..." -ForegroundColor Yellow
        Start-Service -Name "bthserv"
        Write-Host "  蓝牙服务已启动" -ForegroundColor Green
    }
} else {
    Write-Host "  蓝牙服务不存在" -ForegroundColor Red
}

Write-Host ""
Write-Host "=== 修复完成 ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "如果蓝牙仍未出现，请执行以下操作:" -ForegroundColor Yellow
Write-Host "1. 重启电脑进入 BIOS (按 F2 或 Del)" -ForegroundColor White
Write-Host "2. 找到 Advanced -> Onboard Devices Configuration" -ForegroundColor White
Write-Host "3. 确保 Bluetooth 或 WLAN/BT 设置为 Enabled" -ForegroundColor White
Write-Host "4. 保存并退出 (F10)" -ForegroundColor White
Write-Host ""
Write-Host "或者访问华硕官网下载最新的 MT7921 蓝牙驱动程序" -ForegroundColor White
