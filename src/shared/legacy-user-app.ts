import fs from 'node:fs'
import path from 'node:path'

const LEGACY_UI_MARKERS = [
  '虫族',
  '我的虫群',
  'Clerk Setup',
  '女王',
  '工蜂',
]

export function isLegacyUiHtml(html: string): boolean {
  return LEGACY_UI_MARKERS.some(marker => html.includes(marker))
}

export function isLegacyUiDir(uiDir: string): boolean {
  const indexPath = path.join(uiDir, 'index.html')
  if (!fs.existsSync(indexPath)) return false
  try {
    return isLegacyUiHtml(fs.readFileSync(indexPath, 'utf-8'))
  } catch {
    return false
  }
}
