# Download and install protoc for Windows
$protocVersion = "28.2"
$protocZip = "protoc-$protocVersion-win64.zip"
$protocUrl = "https://github.com/protocolbuffers/protobuf/releases/download/v$protocVersion/$protocZip"
$protocDir = "$env:USERPROFILE\protoc"
$protocExe = "$protocDir\bin\protoc.exe"

Write-Host "Downloading protoc $protocVersion..."
Invoke-WebRequest -Uri $protocUrl -OutFile $protocZip

Write-Host "Extracting protoc..."
if (Test-Path $protocDir) {
    Remove-Item -Recurse -Force $protocDir
}
Expand-Archive -Path $protocZip -DestinationPath $protocDir

Write-Host "Adding protoc to PATH..."
$env:PATH += ";$protocDir\bin"
[Environment]::SetEnvironmentVariable("PATH", $env:PATH, "User")

Write-Host "Setting PROTOC environment variable..."
[Environment]::SetEnvironmentVariable("PROTOC", $protocExe, "User")

Write-Host "Cleaning up..."
Remove-Item $protocZip

Write-Host "protoc installed successfully at: $protocExe"
Write-Host "Please restart your terminal to use protoc."
