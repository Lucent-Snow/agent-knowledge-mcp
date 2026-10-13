import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const BEGIN = '// agent-knowledge-mcp managed rules'
const END = '// end agent-knowledge-mcp managed rules'
const RULES = `${BEGIN}
.memory-*.tmp
/.agent-knowledge.json
(?d).DS_Store
!/context
!/context/**
!/project
!/project/**
!/note
!/note/**
!/identity
!/identity/**
*
${END}`

export async function prepareSync(store) {
  return store.locked(async guard => {
    const file = path.join(store.root, '.stignore')
    await store.safePath(file)
    let previous = ''
    try { previous = await readFile(file, 'utf8') } catch (e) { if (e.code !== 'ENOENT') throw e }
    const escaped = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    previous = previous.replace(new RegExp(`${escaped(BEGIN)}[\\s\\S]*?${escaped(END)}\\n?`, 'g'), '').trim()
    const text = (previous ? previous + '\n\n' : '') + RULES + '\n'
    guard(); await store.atomicWrite(file, text, guard)
    return { root: store.root, ignoreFile: file,
      next: 'Share this root as a Send & Receive folder in Syncthing. Pair each device and enable versioning. Run sync-prepare on every device; .stignore is not synchronized.' }
  })
}
