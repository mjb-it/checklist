import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Item, Project, Status } from '../types'

const PANE = 'checklist'
const TITLE = 'Checklist'
const USAGE =
  '/checklist [add <title> [-- detail] | done|open|drop <id> | edit <id> <title> | remove <id> | clear | close]'

const list = atom({ plugin: 'checklist', key: 'list' } as const, { project: '', items: [] as Item[] })

const MARK: Record<Status, string> = { open: '[ ]', done: '[x]', dropped: '[-]' }
const VERB: Partial<Record<string, Status>> = { done: 'done', open: 'open', drop: 'dropped' }

/** The key one project's list is stored under: its git root, else the session's root. */
async function projectKey($: EngineInterface): Promise<string> {
  const repo = await $.session.repo()
  return repo?.root ?? (await $.session.root())
}

async function load($: EngineInterface, project: string): Promise<Project> {
  const saved = (await $.store.get(`project:${project}`)) as Project | undefined
  return saved && Array.isArray(saved.items)
    ? { next: saved.next ?? saved.items.length + 1, items: saved.items }
    : { next: 1, items: [] }
}

async function save($: EngineInterface, project: string, data: Project): Promise<void> {
  await $.store.set(`project:${project}`, data)
  await update($, list, () => ({ project, items: data.items }))
}

const label = (item: Item) => `${item.id}. ${item.title}`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'checklist',
      description: 'Per-project checklist pane: add, edit, done|open|drop, remove, clear',
    })
    const project = await projectKey($)
    const data = await load($, project)
    await update($, list, () => ({ project, items: data.items }))
    // Open unasked only when there is something to show.
    if (data.items.length > 0) void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  on('command.run', { command: 'checklist' }, async ($, e) => {
    const args = e.args.trim()
    if (!args) {
      await $.ui.open({ id: PANE, title: TITLE })
      return { text: `Checklist pane opened. ${USAGE}` }
    }

    const [verb, ...rest] = args.split(/\s+/)
    if (verb === 'close' && rest.length === 0) {
      await $.ui.close({ id: PANE })
      return { text: 'Checklist pane closed. /checklist reopens it.' }
    }
    const project = await projectKey($)
    const data = await load($, project)
    const find = (id: string | undefined) => data.items.find(i => i.id === (id ?? '').toLowerCase())

    if (verb === 'add') {
      const body = args.slice(verb.length).trim()
      const [rawTitle, ...detailParts] = body.split(/\s+--\s+|^--\s+|\s+--$/)
      const title = rawTitle.trim()
      const detail = detailParts.join(' -- ').trim()
      if (!title) return { text: USAGE }
      const item: Item = { id: String(data.next), title, status: 'open', ...(detail ? { detail } : {}) }
      await save($, project, { next: data.next + 1, items: [...data.items, item] })
      await $.ui.open({ id: PANE, title: TITLE })
      return { text: `Added ${label(item)}` }
    }

    const status = VERB[verb]
    if (status) {
      const item = find(rest[0])
      if (!item || rest.length !== 1) return { text: USAGE }
      await save($, project, {
        ...data,
        items: data.items.map(i => (i === item ? { ...i, status } : i)),
      })
      await $.ui.open({ id: PANE, title: TITLE })
      return { text: `${label(item)} is now ${status}.` }
    }

    if (verb === 'edit') {
      const item = find(rest[0])
      const title = rest.slice(1).join(' ').trim()
      if (!item || !title) return { text: USAGE }
      await save($, project, {
        ...data,
        items: data.items.map(i => (i === item ? { ...i, title } : i)),
      })
      await $.ui.open({ id: PANE, title: TITLE })
      return { text: `${item.id}. ${title} (was: ${item.title})` }
    }

    if (verb === 'remove') {
      const item = find(rest[0])
      if (!item || rest.length !== 1) return { text: USAGE }
      await save($, project, { ...data, items: data.items.filter(i => i !== item) })
      await $.ui.open({ id: PANE, title: TITLE })
      return { text: `Removed ${label(item)}` }
    }

    if (verb === 'clear' && rest.length === 0) {
      await save($, project, { next: 1, items: [] })
      const removed = data.items.map(label)
      return {
        text: removed.length
          ? `Cleared ${removed.length} item${removed.length === 1 ? '' : 's'}: ${removed.join('; ')}`
          : 'The checklist was already empty.',
      }
    }

    return { text: USAGE }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const { items } = await read($, list)
    const wide = e.props.bodyColumns >= 56
    const open = items.filter(i => i.status === 'open').length

    return (
      <Box flexDirection="column">
        <Text bold>{open} open of {items.length}</Text>
        {items.length === 0 && <Text dimColor>Nothing yet. /checklist add &lt;title&gt; [-- detail]</Text>}
        {items.map(item => {
          const isOpen = item.status === 'open'
          return (
            <Box key={item.id} flexDirection="column">
              <Text bold={isOpen} dimColor={!isOpen} strikethrough={item.status === 'dropped'}>
                {MARK[item.status]} {label(item)}
              </Text>
              {wide && item.detail && <Text dimColor>      {item.detail}</Text>}
            </Box>
          )
        })}
      </Box>
    )
  })
}
