/** Only the embedded preview response is decorated; saved/downloaded HTML is unchanged. */
export const PREVIEW_ESCAPE_MESSAGE = 'dsh-pro:preview-escape'

export function previewHtml(html: string): string {
  const bridge = `<script>window.addEventListener('keydown',function(event){if(event.key==='Escape'){event.preventDefault();parent.postMessage({type:'${PREVIEW_ESCAPE_MESSAGE}'},'*')}},true)</script>`
  // Preserve standards mode, and install before any scripts in the demo.
  const doctype = html.match(/^\s*<!doctype[^>]*>/i)
  const offset = doctype?.[0].length ?? 0
  return html.slice(0, offset) + bridge + html.slice(offset)
}
