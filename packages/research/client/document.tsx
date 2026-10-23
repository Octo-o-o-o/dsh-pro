import type { ReactNode } from 'react'

/** A deliberately small, text-only Markdown reader. Raw HTML and links stay inert. */
function inline(text: string): ReactNode {
  return text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g).map((part, index) =>
    part.startsWith('**') && part.endsWith('**') ? <strong key={index}>{part.slice(2, -2)}</strong>
      : part.startsWith('`') && part.endsWith('`') ? <code key={index}>{part.slice(1, -1)}</code> : part)
}

export function DocumentContent({ text }: { text: string }): ReactNode {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  for (let i = 0; i < lines.length;) {
    const line = lines[i] ?? ''
    const key = i
    if (line.trim() === '') { i++; continue }
    if (/^\s*```/.test(line)) {
      const code: string[] = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i] ?? '')) code.push(lines[i++] ?? '')
      i++
      blocks.push(<pre key={key}><code>{code.join('\n')}</code></pre>)
      continue
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading !== null) {
      const Tag = heading[1]?.length === 1 ? 'h2' : heading[1]?.length === 2 ? 'h3' : 'h4'
      blocks.push(<Tag key={key}>{inline(heading[2] ?? '')}</Tag>); i++; continue
    }
    if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) { blocks.push(<hr key={key} />); i++; continue }
    if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]/.test(line)
      const pattern = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/
      const items: ReactNode[] = []
      while (i < lines.length && pattern.test(lines[i] ?? '')) {
        items.push(<li key={i}>{inline((lines[i++] ?? '').replace(pattern, ''))}</li>)
      }
      blocks.push(ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>); continue
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i] ?? '')) quote.push((lines[i++] ?? '').replace(/^\s*>\s?/, ''))
      blocks.push(<blockquote key={key}>{inline(quote.join('\n'))}</blockquote>); continue
    }
    if (line.includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? '')) {
      const cells = (row: string): string[] => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())
      const headers = cells(line)
      const rows: string[][] = []
      i += 2
      while (i < lines.length && (lines[i] ?? '').includes('|') && (lines[i] ?? '').trim() !== '') rows.push(cells(lines[i++] ?? ''))
      blocks.push(<div className="dshpro-document-table" key={key}><table><thead><tr>{headers.map((cell, n) => <th key={n}>{inline(cell)}</th>)}</tr></thead><tbody>{rows.map((row, n) => <tr key={n}>{row.map((cell, c) => <td key={c}>{inline(cell)}</td>)}</tr>)}</tbody></table></div>); continue
    }
    const paragraph: string[] = [line]
    i++
    while (i < lines.length && (lines[i] ?? '').trim() !== '' && !/^(?:#{1,6}\s|\s*```|\s*[-*+]\s|\s*\d+[.)]\s|\s*>|---+$)/.test(lines[i] ?? '')) paragraph.push(lines[i++] ?? '')
    blocks.push(<p key={key}>{inline(paragraph.join('\n'))}</p>)
  }
  return <article className="dshpro-document">{blocks}</article>
}
