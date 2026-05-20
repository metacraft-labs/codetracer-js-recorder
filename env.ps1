# codetracer-js-recorder Windows dev environment (PowerShell)
# Usage:  . .\env.ps1
#
# CodeTracer is normally developed inside a Nix dev shell. This script is
# the Windows equivalent: it provisions the toolchain the recorder needs —
# Rust (for the napi-rs native addon), Node.js (for the TypeScript
# packages and the napi-rs CLI), and just (the documented task runner) —
# into a deterministic install root, then wires them onto PATH for this
# shell. Pinned versions live in non-nix-build/windows/toolchain-versions.env.

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$scriptDir = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Definition) "non-nix-build\windows"

# Parse toolchain versions
$toolchainFile = Join-Path $scriptDir "toolchain-versions.env"
$toolchain = @{}
Get-Content $toolchainFile | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith("#")) {
        $parts = $line -split "=", 2
        $toolchain[$parts[0].Trim()] = $parts[1].Trim()
    }
}

# Shared with the other CodeTracer repos' Windows DIY environments so a
# single binary cache serves the whole workspace.
$installRoot = if ($env:WINDOWS_DIY_INSTALL_ROOT) { $env:WINDOWS_DIY_INSTALL_ROOT }
               else { Join-Path $env:LOCALAPPDATA "codetracer/windows-diy" }
New-Item -ItemType Directory -Force -Path $installRoot | Out-Null

$arch = if ((Get-CimInstance Win32_ComputerSystem).SystemType -match "ARM") { "arm64" } else { "x64" }

# --- Ensure Rust ---
$rustupHome = Join-Path $installRoot "rustup"
$cargoHome = Join-Path $installRoot "cargo"
$env:RUSTUP_HOME = $rustupHome
$env:CARGO_HOME = $cargoHome
$rustcExe = Join-Path $cargoHome "bin/rustc.exe"
$rustupExe = Join-Path $cargoHome "bin/rustup.exe"
$rustToolchain = $toolchain["RUST_TOOLCHAIN_VERSION"]

$needRust = $true
if (Test-Path $rustcExe) {
    $rustcVer = (& $rustcExe --version 2>&1)
    if ($rustcVer -match "^rustc $([regex]::Escape($rustToolchain)) ") {
        Write-Host "Rust $rustToolchain already installed"
        $needRust = $false
    }
}
if ($needRust) {
    Write-Host "Installing Rust $rustToolchain..."
    New-Item -ItemType Directory -Force -Path $rustupHome | Out-Null
    New-Item -ItemType Directory -Force -Path $cargoHome | Out-Null
    $rustupInit = Join-Path $env:TEMP "rustup-init.exe"
    $target = if ($arch -eq "arm64") { "aarch64-pc-windows-msvc" } else { "x86_64-pc-windows-msvc" }
    $rustupUrl = "https://static.rust-lang.org/rustup/dist/$target/rustup-init.exe"
    Invoke-WebRequest -Uri $rustupUrl -OutFile $rustupInit
    & $rustupInit --default-toolchain $rustToolchain --profile minimal -y --no-modify-path
    if ($LASTEXITCODE -ne 0) { throw "rustup-init failed" }
    Remove-Item $rustupInit -Force -ErrorAction SilentlyContinue
}
# rust-toolchain.toml pins the channel + extra components; rustup tops
# them up on first cargo use. Pre-install clippy for `just lint`.
& $rustupExe component add clippy 2>&1 | Out-Null

# --- Ensure Node.js ---
$nodeVersion = $toolchain["NODE_VERSION"]
if ($arch -ne "x64") { throw "Node.js provisioning in this script only supports x64." }
$nodeDir = Join-Path $installRoot "node/$nodeVersion/node-v$nodeVersion-win-x64"
$nodeExe = Join-Path $nodeDir "node.exe"

if (Test-Path $nodeExe) {
    Write-Host "Node.js $nodeVersion already installed"
} else {
    Write-Host "Installing Node.js $nodeVersion..."
    $nodeUrl = "https://nodejs.org/dist/v$nodeVersion/node-v$nodeVersion-win-x64.zip"
    $nodeZip = Join-Path $env:TEMP "node-$nodeVersion.zip"
    Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeZip
    $nodeParent = Split-Path -Parent $nodeDir
    New-Item -ItemType Directory -Force -Path $nodeParent | Out-Null
    Expand-Archive -Path $nodeZip -DestinationPath $nodeParent -Force
    Remove-Item $nodeZip
    Write-Host "Installed Node.js to $nodeDir"
}

# --- Ensure just ---
$justVersion = $toolchain["JUST_VERSION"]
$justDir = Join-Path $installRoot "just/$justVersion"
$justExe = Join-Path $justDir "just.exe"

if (Test-Path $justExe) {
    Write-Host "just $justVersion already installed"
} else {
    Write-Host "Installing just $justVersion..."
    $justUrl = "https://github.com/casey/just/releases/download/$justVersion/just-$justVersion-x86_64-pc-windows-msvc.zip"
    $justZip = Join-Path $env:TEMP "just-$justVersion.zip"
    Invoke-WebRequest -Uri $justUrl -OutFile $justZip
    New-Item -ItemType Directory -Force -Path $justDir | Out-Null
    Expand-Archive -Path $justZip -DestinationPath $justDir -Force
    Remove-Item $justZip
    Write-Host "Installed just to $justDir"
}

# --- Ensure Nim ---
# Building the native addon pulls in the `codetracer_trace_writer_nim`
# crate, whose build script compiles a Nim static library — so the Nim
# compiler must be on PATH. The prebuilt Windows distribution bundles
# `vccexe`, which lets `nim --cc:vcc` locate the MSVC toolchain itself.
$nimVersion = $toolchain["NIM_VERSION"]
$nimDir = Join-Path $installRoot "nim/$nimVersion/nim-$nimVersion"
$nimExe = Join-Path $nimDir "bin/nim.exe"

if (Test-Path $nimExe) {
    Write-Host "Nim $nimVersion already installed"
} else {
    if ($arch -ne "x64") { throw "Nim provisioning in this script only supports x64." }
    Write-Host "Installing Nim $nimVersion..."
    $nimUrl = "https://nim-lang.org/download/nim-${nimVersion}_x64.zip"
    $nimZip = Join-Path $env:TEMP "nim-$nimVersion.zip"
    Invoke-WebRequest -Uri $nimUrl -OutFile $nimZip
    $nimParent = Split-Path -Parent $nimDir
    New-Item -ItemType Directory -Force -Path $nimParent | Out-Null
    Expand-Archive -Path $nimZip -DestinationPath $nimParent -Force
    Remove-Item $nimZip
    Write-Host "Installed Nim to $nimDir"
}

# --- Git bash (needed by `npm test` -> verify-cli-convention shell guard) ---
# `npm test` runs `bash tests/verify-cli-convention-no-silent-skip.sh`.
# Derive the Git bash directory from wherever `git` resolves on PATH, so a
# non-standard Git install (scoop, winget, portable) is still found.
$gitBashDir = $null
$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if ($gitCmd) {
    $gitRoot = Split-Path -Parent (Split-Path -Parent $gitCmd.Source)
    foreach ($rel in @("bin", "usr\bin")) {
        $cand = Join-Path $gitRoot $rel
        if (Test-Path (Join-Path $cand "bash.exe")) { $gitBashDir = $cand; break }
    }
}

# --- Set PATH ---
$pathEntries = @((Join-Path $cargoHome "bin"), $nodeDir, $justDir, (Join-Path $nimDir "bin"))
if ($gitBashDir) { $pathEntries += $gitBashDir }
foreach ($entry in $pathEntries) {
    if ($entry -and ($env:Path -notlike "*$entry*")) {
        $env:Path = "$entry;$($env:Path)"
    }
}

Write-Host ""
Write-Host "codetracer-js-recorder environment ready."
Write-Host "  install root : $installRoot"
Write-Host "  rustc        : $((& rustc --version) 2>&1)"
Write-Host "  node         : $((& node --version) 2>&1)"
Write-Host "  npm          : $((& npm --version) 2>&1)"
Write-Host "  just         : $((& just --version) 2>&1)"
Write-Host "  nim          : $(((& nim --version 2>&1) | Select-Object -First 1))"
if ($gitBashDir) {
    Write-Host "  bash         : $(Join-Path $gitBashDir 'bash.exe')"
} else {
    Write-Host "  bash         : (not found — install Git for Windows; 'npm test' needs it)"
}
Write-Host ""
