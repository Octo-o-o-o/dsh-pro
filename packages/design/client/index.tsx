import { apply, configure, inject } from '../../research/client/panel.tsx'

configure({
  routes: '/gpt-image-design',
  panelId: 'gpt-image-design',
  title: 'GPT-Image Design',
  label: 'Image Design',
  icon: 'design',
  designMode: true,
})

export { apply, inject }
