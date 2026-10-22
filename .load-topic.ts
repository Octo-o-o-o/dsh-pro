import { ResearchStore } from './packages/core/src/index.ts'
import { readFile } from 'node:fs/promises'

const registry = JSON.parse(await readFile('C:/Users/satan/.dsh/chatgpt-pro-research/registry.json', 'utf8'))
console.log(registry.topics)
for (const entry of registry.topics) {
  const store = new ResearchStore({
    mode: entry.mode,
    projectRoot: entry.root,
    localRoot: 'C:/Users/satan/.dsh/chatgpt-pro-research',
    rawDir: 'C:/Users/satan/.dsh/chatgpt-pro-research/raw',
    rawAnswers: 'local',
  })
  try {
    const topic = await store.load(entry.id)
    console.log('loaded', entry.id, topic.status, await store.dirOf(entry.id))
  } catch (error) {
    console.log('load failed', entry.id, error.message)
  }
}
