#!/usr/bin/env node
/**
 * Minimal CLI for the transport, so M1 can be exercised without DSH:
 *
 *   node packages/transport/src/cli.ts login
 *   node packages/transport/src/cli.ts probe
 *   node packages/transport/src/cli.ts submit --brief-file brief.md \
 *     --file README.md --file docs/design.md --out answer.md [--model pro]
 *
 * Node 24 runs the TypeScript directly (type stripping); no build needed.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { ChatGptWebTransport } from './chatgpt.ts'

function usage(): never {
  console.error('usage: cli.ts <login|probe|submit> [options]')
  process.exit(1)
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return undefined
  return process.argv[index + 1]
}

function options(name: string): string[] {
  const values: string[] = []
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] === `--${name}` && process.argv[i + 1] !== undefined) values.push(process.argv[i + 1] as string)
  }
  return values
}

const command = process.argv[2]
if (command === undefined) usage()

const profileDir = process.env.DSH_PRO_BROWSER ?? join(homedir(), '.dsh', 'pro-research', 'browser')
const transport = new ChatGptWebTransport({ profileDir })

try {
  if (command === 'login') {
    await transport.login()
    console.log(JSON.stringify({ ok: true, profileDir }, null, 2))
  } else if (command === 'probe') {
    console.log(JSON.stringify(await transport.probe(), null, 2))
  } else if (command === 'submit') {
    const briefFile = option('brief-file')
    if (briefFile === undefined) usage()
    const brief = await readFile(resolve(briefFile), 'utf8')
    const files = options('file').map(file => resolve(file))
    const model = option('model') ?? 'pro'
    const submitted = await transport.submit({ topicId: 'cli', round: 1, brief, files, model })
    console.log(JSON.stringify({ submitted: { ...submitted, page: undefined } }, null, 2))
    let answer = ''
    const deadline = Date.now() + 90 * 60_000
    while (Date.now() < deadline) {
      const polled = await transport.poll({ submissionId: submitted.submissionId, timeoutMs: 60_000 })
      if (polled.state === 'answered') {
        answer = polled.answer ?? (await transport.fetch({ submissionId: submitted.submissionId })).answer
        break
      }
      if (polled.state === 'unknown') throw new Error('page state unknown; inspect the browser window')
    }
    if (answer === '') throw new Error('no answer before the deadline')
    const out = option('out')
    if (out !== undefined) await writeFile(resolve(out), answer, 'utf8')
    console.log(JSON.stringify({ answered: true, characters: answer.length, out: out ?? null }, null, 2))
  } else {
    usage()
  }
} finally {
  await transport.close()
}
