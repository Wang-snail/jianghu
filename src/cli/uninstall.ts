import { execSync } from 'child_process'
import { existsSync, rmSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { createInterface } from 'readline'

const IS_WIN = process.platform === 'win32'

const UNIX_PATHS = {
  lib: '/usr/local/lib/jianghu',
  bin: '/usr/local/bin/jianghu',
  data: join(homedir(), '.jianghu'),
  logs: join(homedir(), 'Library', 'Logs', '江湖'),
}
const PKG_ID = 'ai.jianghu.room'

function getWindowsInstallDir(): string | null {
  try {
    const out = execSync(
      'reg query "HKLM\\Software\\江湖" /v InstallDir',
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    )
    const match = out.match(/InstallDir\s+REG_SZ\s+(.+)/i)
    return match ? match[1].trim() : null
  } catch {
    return null
  }
}

function stopServerWindows(): void {
  // Kill Jianghu-related node processes via taskkill
  try {
    execSync('taskkill /F /IM node.exe /FI "WINDOWTITLE eq *jianghu*"', { stdio: 'ignore' })
  } catch { /* no matching processes */ }

  // Kill any process listening on the default Jianghu port (4700)
  try {
    execSync(
      'powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 4700 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"',
      { stdio: 'ignore' }
    )
  } catch { /* no listeners */ }
}

function uninstallWindows(): void {
  const dataDir = join(homedir(), '.jianghu')

  // Stop server
  stopServerWindows()

  // Remove data directory
  if (existsSync(dataDir)) {
    rmSync(dataDir, { recursive: true, force: true })
    console.log(`Removed ${dataDir}`)
  }

  // Remove install directory (read from registry)
  const installDir = getWindowsInstallDir()
  if (installDir && existsSync(installDir)) {
    try {
      rmSync(installDir, { recursive: true, force: true })
      console.log(`Removed ${installDir}`)
    } catch {
      console.error(`Failed to remove ${installDir}. Run as Administrator or remove manually.`)
    }
  }

  // Clean registry keys
  try {
    execSync('reg delete "HKLM\\Software\\江湖" /f', { stdio: 'ignore' })
    console.log('Removed registry key: HKLM\\Software\\江湖')
  } catch { /* key may not exist */ }
  try {
    execSync('reg delete "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\江湖" /f', { stdio: 'ignore' })
    console.log('Removed uninstall registry entry.')
  } catch { /* key may not exist */ }

  console.log('\n江湖 has been uninstalled.')
  console.log('Note: You can also use "Add or Remove Programs" in Windows Settings.')
}

function uninstallUnix(): void {
  // Stop server
  try { execSync('pkill -f "jianghu serve"', { stdio: 'ignore' }) } catch {}

  // Remove data & logs (no sudo needed)
  for (const dir of [UNIX_PATHS.data, UNIX_PATHS.logs]) {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
      console.log(`Removed ${dir}`)
    }
  }

  // Remove binary and lib (needs sudo)
  const needsSudo = existsSync(UNIX_PATHS.lib) || existsSync(UNIX_PATHS.bin)
  if (needsSudo) {
    console.log('\nRemoving /usr/local/lib/jianghu and /usr/local/bin/jianghu (requires sudo)...')
    try {
      execSync(`sudo rm -rf ${UNIX_PATHS.lib} ${UNIX_PATHS.bin}`, { stdio: 'inherit' })
      console.log('Removed binaries.')
    } catch {
      console.error('Failed to remove binaries. Run manually:\n  sudo rm -rf /usr/local/lib/jianghu /usr/local/bin/jianghu')
    }
  }

  // Forget pkg receipt (macOS)
  try {
    execSync(`sudo pkgutil --forget ${PKG_ID}`, { stdio: 'ignore' })
    console.log('Removed package receipt.')
  } catch {}

  console.log('\n江湖 has been uninstalled.')
}

export function runUninstall(): void {
  const rl = createInterface({ input: process.stdin, output: process.stdout })

  rl.question('This will remove 江湖 and all its data. Continue? [y/N] ', (answer) => {
    rl.close()
    if (answer.trim().toLowerCase() !== 'y') {
      console.log('Cancelled.')
      process.exit(0)
    }

    if (IS_WIN) {
      uninstallWindows()
    } else {
      uninstallUnix()
    }
  })
}
