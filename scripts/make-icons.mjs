// Build marketplace icons from the in-app Anyvia R / X marks.
// Run from the repository root: node scripts/make-icons.mjs
import { readFileSync, writeFileSync } from 'node:fs'

const src = readFileSync(new URL('../packages/research/client/icons.ts', import.meta.url), 'utf8')
const specs = [
  { key: 'RESEARCH_ICON', pkg: 'research', title: 'Pro Research', prefix: 'research' },
  { key: 'DESIGN_ICON', pkg: 'design', title: 'Image Design', prefix: 'design' },
]

for (const spec of specs) {
  const line = src.split(/\r?\n/).find(l => l.trimStart().startsWith(`export const ${spec.key} =`))
  if (!line) throw new Error(`missing ${spec.key}`)
  const svg = JSON.parse(line.slice(line.indexOf('"'), line.lastIndexOf('"') + 1))
  const viewBox = svg.match(/viewBox="([^"]+)"/)?.[1]
  if (!viewBox) throw new Error(`missing viewBox in ${spec.key}`)

  let inner = svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')
  inner = inner.replace(/<title>[\s\S]*?<\/title>/, `<title>${spec.title}</title>`)
  inner = inner.replaceAll('currentColor', '#ffffff')
  // Keep mask ids unique when both icons appear on one page.
  inner = inner.replaceAll('id="', `id="${spec.prefix}-`).replaceAll('url(#', `url(#${spec.prefix}-`)

  const out = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128" role="img" aria-label="${spec.title}">
  <rect width="128" height="128" rx="28" fill="#111827"/>
  <svg x="14" y="14" width="100" height="100" viewBox="${viewBox}" preserveAspectRatio="xMidYMid meet">
${inner}
  </svg>
</svg>
`
  const dest = new URL(`../packages/${spec.pkg}/icon.svg`, import.meta.url)
  writeFileSync(dest, out)
  console.log(`wrote packages/${spec.pkg}/icon.svg`)
}
