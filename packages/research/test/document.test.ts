import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DocumentContent } from '../client/document.tsx'

const render = (text: string): string => renderToStaticMarkup(createElement(DocumentContent, { text }))

describe('saved research document reader', () => {
  it('renders structure while keeping untrusted HTML and links inert', () => {
    const html = render('# 已有总结\n\n**结论**与`<script>`\n\n<img src=x onerror=alert(1)>\n\n[链接](javascript:alert(1))')
    expect(html).toContain('<h2>已有总结</h2>')
    expect(html).toContain('<strong>结论</strong>')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<a ')
  })

  it('preserves code, list items and tabular evidence without interpreting code as markup', () => {
    const html = render('## 检查\r\n\r\n- 通过\r\n- 未运行\r\n\r\n| 项目 | 状态 |\n| --- | --- |\n| 本机 | **通过** |\n\n```html\n<h1>不执行</h1>\n```')
    expect(html).toContain('<li>未运行</li>')
    expect(html).toContain('<th>状态</th>')
    expect(html).toContain('<td><strong>通过</strong></td>')
    expect(html).toContain('&lt;h1&gt;不执行&lt;/h1&gt;')
    expect(html).not.toContain('<h1>')
  })

  it('retains incomplete fenced text at the preview cutoff', () => {
    expect(render('```\n# 保留原文\n最后一行')).toContain('# 保留原文\n最后一行')
  })
})
