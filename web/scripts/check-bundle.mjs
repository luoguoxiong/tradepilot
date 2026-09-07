#!/usr/bin/env node
/**
 * Bundle 体积门禁（前端技术方案 06 §1 / 排期 M6-5）：
 * - 全站最大单 chunk（JS，gzip）≤ 500KB；
 * - 首屏 JS（gzip，登录后 Dashboard）≤ 300KB = entry + element-plus + Dashboard 路由 chunk。
 * 读取 dist/assets 构建产物实时 gzip 计算，超预算 exit 1（CI 门禁）。
 */
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs'
import { createGzip } from 'node:zlib'
import { join } from 'node:path'

const DIST = new URL('../dist/assets/', import.meta.url).pathname

/** 预算（06 §1 性能预算表） */
const MAX_CHUNK_KB = 500
const FIRST_LOAD_KB = 300

/** 首屏 chunk 识别：entry（index-*）+ 全局 vendor（element-plus）+ Dashboard 路由 chunk */
const FIRST_LOAD_PATTERNS = [/^index-.*\.js$/, /^element-plus.*\.js$/, /Dashboard.*\.js$/]

function gzipSize(filePath) {
  return new Promise((resolve, reject) => {
    const chunks = []
    createReadStream(filePath)
      .pipe(createGzip())
      .on('data', (c) => chunks.push(c))
      .on('end', () => resolve(Buffer.concat(chunks).length))
      .on('error', reject)
  })
}

if (!existsSync(DIST)) {
  console.error('[size] dist/assets 不存在，请先执行 pnpm build')
  process.exit(1)
}

const jsFiles = readdirSync(DIST).filter((f) => f.endsWith('.js'))
if (jsFiles.length === 0) {
  console.error('[size] dist/assets 中无 JS 产物')
  process.exit(1)
}

const rows = []
for (const file of jsFiles) {
  const size = statSync(join(DIST, file)).size
  const gz = await gzipSize(join(DIST, file))
  rows.push({ file, rawKB: size / 1024, gzipKB: gz / 1024 })
}

const failures = []

// 门禁 1：全站最大单 chunk（gzip）
const maxChunk = rows.reduce((a, b) => (b.gzipKB > a.gzipKB ? b : a))
if (maxChunk.gzipKB > MAX_CHUNK_KB) {
  failures.push(`最大单 chunk ${maxChunk.file} gzip ${maxChunk.gzipKB.toFixed(1)}KB > ${MAX_CHUNK_KB}KB`)
}

// 门禁 2：首屏 JS（gzip）
const firstLoad = rows.filter((r) => FIRST_LOAD_PATTERNS.some((p) => p.test(r.file)))
const firstLoadKB = firstLoad.reduce((sum, r) => sum + r.gzipKB, 0)
if (firstLoadKB > FIRST_LOAD_KB) {
  failures.push(
    `首屏 JS gzip ${firstLoadKB.toFixed(1)}KB > ${FIRST_LOAD_KB}KB（${firstLoad.map((r) => r.file).join(' + ')}）`,
  )
}

// 报告
console.log('\n[size] JS 产物体积（gzip）：')
for (const r of [...rows].sort((a, b) => b.gzipKB - a.gzipKB)) {
  console.log(`  ${r.gzipKB.toFixed(1).padStart(8)}KB  (raw ${r.rawKB.toFixed(1).padStart(8)}KB)  ${r.file}`)
}
console.log(`\n[size] 首屏合计（entry + element-plus + Dashboard）：${firstLoadKB.toFixed(1)}KB / ${FIRST_LOAD_KB}KB`)
console.log(`[size] 最大单 chunk：${maxChunk.file} ${maxChunk.gzipKB.toFixed(1)}KB / ${MAX_CHUNK_KB}KB\n`)

if (failures.length > 0) {
  for (const f of failures) console.error(`[size] ✘ ${f}`)
  process.exit(1)
}
console.log('[size] ✔ 体积门禁通过')
