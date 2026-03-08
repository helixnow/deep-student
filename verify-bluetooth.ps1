# 蓝牙验证脚本 - 重启后运行此脚本检查蓝牙状态

Write-Host "=== 蓝牙状态检查 ===" -ForegroundColor Cyan
Write-Host ""

# 1. 检查蓝牙服务
Write-Host "1. 检查蓝牙服务状态..." -ForegroundColor Yellow
$bthService = Get-Service -Name "bthserv" -ErrorAction SilentlyContinue
if ($bthService) {
    Write-Host "   服务状态: $($bthService.Status)" -ForegroundColor Green
    if ($bthService.Status -ne "Running") {
        Write-Host "   正在启动蓝牙服务..." -ForegroundColor Yellow
        Start-Service -Name "bthserv"
        Write-Host "   蓝牙服务已启动" -ForegroundColor Green
    }
} else {
    Write-Host "   蓝牙服务不存在!" -ForegroundColor Red
}

Write-Host ""

# 2. 检查蓝牙适配器
Write-Host "2. 检查蓝牙适配器..." -ForegroundColor Yellow
$btAdapter = Get-PnpDevice -Class Bluetooth -ErrorAction SilentlyContinue | Where-Object {$_.FriendlyName -like "*Adapter*"}
if ($btAdapter) {
    Write-Host "   找到蓝牙适配器: $($btAdapter.FriendlyName)" -ForegroundColor Green
    Write-Host "   状态: $($btAdapter.Status)" -ForegroundColor $(if ($btAdapter.Status -eq "OK") {"Green"} else {"Yellow"})
    if ($btAdapter.Problem) {
        Write-Host "   问题代码: $($btAdapter.Problem)" -ForegroundColor Red
    }
} else {
    Write-Host "   未找到蓝牙适配器!" -ForegroundColor Red
    Write-Host "   正在重新扫描硬件..." -ForegroundColor Yellow
    pnputil /scan-devices
    Start-Sleep -Seconds 2
    $btAdapter = Get-PnpDevice -Class Bluetooth -ErrorAction SilentlyContinue | Where-Object {$_.FriendlyName -like "*Adapter*"}
    if ($btAdapter) {
        Write-Host "   扫描后找到: $($btAdapter.FriendlyName)" -ForegroundColor Green
    } else {
        Write-Host "   仍未找到蓝牙适配器，可能需要手动在设备管理器中检查" -ForegroundColor Red
    }
}

Write-Host ""

# 3. 列出所有蓝牙设备
Write-Host "3. 蓝牙设备列表..." -ForegroundColor Yellow
$btDevices = Get-PnpDevice -Class Bluetooth -ErrorAction SilentlyContinue
if ($btDevices) {
    $btDevices | Select-Object Status, FriendlyName | Format-Table -AutoSize
} else {
    Write-Host "   没有找到任何蓝牙设备" -ForegroundColor Red
}

Write-Host ""
Write-Host "=== 检查完成 ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "如果蓝牙适配器正常，您现在应该能在系统托盘或快速设置中看到蓝牙按钮了。" -ForegroundColor Green
Write-Host "如果仍然有问题，请按 Win + I 打开设置 -> 蓝牙和设备，查看蓝牙开关是否显示。" -ForegroundColor Yellow
