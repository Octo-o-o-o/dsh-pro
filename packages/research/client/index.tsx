import { apply, configure, inject } from './panel.tsx'

configure({
  routes: '/chatgpt-pro-research',
  panelId: 'chatgpt-pro-research',
  title: 'ChatGPT Pro Research',
  label: 'Pro Research',
  designMode: false,
})

export { apply, inject }
