import { expect, mock, test } from 'claude-code/testing'

type On = Parameters<Parameters<typeof test>[1]>[1]

const PANE = {
  plugin: 'checklist',
  component: 'Pane',
  requestId: 'checklist',
  props: {
    title: 'Checklist',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const START = { cwd: '/work/alpha', surface: 'terminal', isInteractive: true } as const
const TOOL = 'mcp__checklist__checklist'

/** The engine beneath the plugin: a store, a project, and the pane's answers. */
function stubEngine(on: On, initial = '/work/alpha', saved?: Record<string, unknown>) {
  // The session's root, and the repository its shell is in now: a shell `cd` moves only the second.
  let project = initial
  let repo: string | null = initial
  mock.store(on, saved)
  on('command.register', () => ({ value: { command: 'checklist' } }))
  on('tool.register', () => ({ value: { tool: TOOL } }))
  on('tool.call', () => ({ deny: 'nothing beneath the plugin serves this tool' }))
  on('session.repo', () => ({ value: repo === null ? null : { root: repo, remote: null, internal: false, name: null } }))
  on('session.root', () => ({ value: project }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  // The engine's own drawing of a site, where a hook hands it on.
  on('ui.render', () => ({ type: 'Text', children: ['engine'] }))
  const opened: string[] = []
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  const closed: string[] = []
  on('ui.close', (_, e) => {
    closed.push(e.id)
    return { value: undefined }
  })
  return {
    opened,
    closed,
    setProject: (root: string) => void (project = repo = root),
    setShellDir: (repoRoot: string | null) => void (repo = repoRoot),
  }
}

const run = ($: any, args: string) => $.command.run({ command: 'checklist', args })
const row = (ui: any, id: string) => ui.find({ type: 'Button', key: `item:${id}` })

test('the pane shows the header, marks, and details when wide', async ($, on) => {
  stubEngine(on)
  await $.session.start(START)
  await run($, 'add Write the README -- usage and install lines')
  await run($, 'add Ship it')
  await run($, 'add Weigh the cost')
  await run($, 'done 2')
  await run($, 'drop 3')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /open of/ }))?.text).toBe('1 open of 3')
    expect((await row(ui, '1'))?.text).toBe('[ ] 1. Write the README')
    expect((await row(ui, '2'))?.text).toBe('[x] 2. Ship it')
    expect((await row(ui, '3'))?.text).toBe('[-] 3. Weigh the cost')
    expect((await ui.find({ type: 'Text', text: /usage and install/ }))?.text).toContain('usage and install lines')
    await ui.unmount()
  }

  // Narrower than 56 columns, the detail line is left out.
  const narrow = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 40 }, surface: 'terminal' })
  expect(await narrow.find({ type: 'Text', text: /usage and install/ })).toBeUndefined()
  expect((await row(narrow, '1'))?.text).toBe('[ ] 1. Write the README')
  await narrow.unmount()
})

test('a click on a row toggles it between open and done', async ($, on) => {
  stubEngine(on)
  await $.session.start(START)
  await run($, 'add Click me')
  await run($, 'add Dropped one')
  await run($, 'drop 2')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'item:1' })
  expect((await row(ui, '1'))?.text).toBe('[x] 1. Click me')
  await ui.press({ key: 'item:1' })
  expect((await row(ui, '1'))?.text).toBe('[ ] 1. Click me')
  // A dropped item comes back to open.
  await ui.press({ key: 'item:2' })
  expect((await row(ui, '2'))?.text).toBe('[ ] 2. Dropped one')
  expect((await ui.find({ type: 'Text', text: /open of/ }))?.text).toBe('2 open of 2')
  await ui.unmount()

  // The click reached the store: a new session reads it back.
  await $.session.start(START)
  const again = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await again.find({ type: 'Text', text: /open of/ }))?.text).toBe('2 open of 2')
  await again.unmount()
})

test('an empty project shows an empty pane and does not open it at start', async ($, on) => {
  const { opened } = stubEngine(on)
  await $.session.start(START)
  expect(opened).toEqual([])

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /open of/ }))?.text).toBe('0 open of 0')
  await ui.unmount()

  const ran = await run($, '')
  expect(ran.text).toContain('Checklist pane opened')
  expect(opened).toEqual(['checklist'])
})

test('/checklist close closes the pane', async ($, on) => {
  const { closed } = stubEngine(on)
  await $.session.start(START)
  await run($, '')

  const ran = await run($, 'close')
  expect(ran.text).toBe('Checklist pane closed. /checklist reopens it.')
  expect(closed).toEqual(['checklist'])
  expect((await run($, 'close now')).text).toContain('/checklist [add <title>')
})

test('each command changes the list and reports what it did', async ($, on) => {
  stubEngine(on)
  await $.session.start(START)

  expect((await run($, 'add First thing')).text).toBe('Added 1. First thing')
  expect((await run($, 'add Second thing -- with a detail')).text).toBe('Added 2. Second thing')
  expect((await run($, 'done 1')).text).toBe('1. First thing is now done.')
  expect((await run($, 'open 1')).text).toBe('1. First thing is now open.')
  expect((await run($, 'drop 2')).text).toBe('2. Second thing is now dropped.')
  expect((await run($, 'edit 2 Second thing, renamed')).text).toBe('2. Second thing, renamed (was: Second thing)')
  expect((await run($, 'remove 1')).text).toBe('Removed 1. First thing')

  // A removed item stays, struck through under its number, so the numbers run on with no gap.
  expect((await run($, 'add Third thing')).text).toBe('Added 3. Third thing')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // The header leaves removed items out.
  expect((await ui.find({ type: 'Text', text: /open of/ }))?.text).toBe('1 open of 2')
  expect((await ui.find({ type: 'Text', text: /First thing/ }))?.text).toBe('[~] 1. First thing')
  expect((await row(ui, '2'))?.text).toBe('[-] 2. Second thing, renamed')
  expect((await row(ui, '3'))?.text).toBe('[ ] 3. Third thing')
  await ui.unmount()
  expect((await $.tool.call({ tool: TOOL, action: 'list' })).result).toBe(
    '[~] 1. First thing\n[-] 2. Second thing, renamed -- with a detail\n[ ] 3. Third thing',
  )

  // open brings a removed item back.
  expect((await run($, 'open 1')).text).toBe('1. First thing is now open.')
  expect((await run($, 'clear')).text).toBe(
    'Cleared 3 items: 1. First thing; 2. Second thing, renamed; 3. Third thing',
  )
  expect((await run($, 'clear')).text).toBe('The checklist was already empty.')
})

test('unknown input prints one line of usage', async ($, on) => {
  stubEngine(on)
  await $.session.start(START)
  await run($, 'add Only item')

  for (const bad of ['frobnicate', 'done', 'done 9', 'done 1 2', 'edit 1', 'remove', 'add', 'clear now']) {
    const ran = await run($, bad)
    expect(ran.text).toContain('/checklist [add <title>')
    expect(ran.text.split('\n').length).toBe(1)
  }
})

test('the model manages the list through the checklist tool', async ($, on) => {
  const { opened } = stubEngine(on)
  await $.session.start(START)

  const added = await $.tool.call({ tool: TOOL, action: 'add', title: 'From the model', detail: 'agreed in chat' })
  // A plugin tool answers the model with text.
  expect(added.result).toBe('Added 1. From the model\n[ ] 1. From the model -- agreed in chat')
  expect(opened).toEqual(['checklist'])

  const done = await $.tool.call({ tool: TOOL, action: 'done', id: '1' })
  expect(done.result).toBe('1. From the model is now done.\n[x] 1. From the model -- agreed in chat')
  expect((await $.tool.call({ tool: TOOL, action: 'edit', id: '1', title: 'Renamed' })).result).toBe(
    '1. Renamed (was: From the model)\n[x] 1. Renamed -- agreed in chat',
  )
  expect((await $.tool.call({ tool: TOOL, action: 'list' })).result).toBe('[x] 1. Renamed -- agreed in chat')

  // What the person typed and what the model did share one list.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await row(ui, '1'))?.text).toBe('[x] 1. Renamed')
  await ui.unmount()
  expect((await run($, 'remove 1')).text).toBe('Removed 1. Renamed')
  expect((await $.tool.call({ tool: TOOL, action: 'list' })).result).toBe('[~] 1. Renamed -- agreed in chat')
  expect((await $.tool.call({ tool: TOOL, action: 'remove', id: '1' })).result).toBe(
    'Removed 1. Renamed\n[~] 1. Renamed -- agreed in chat',
  )
  expect((await $.tool.call({ tool: TOOL, action: 'clear' })).result).toBe('Cleared 1 item: 1. Renamed\nThe checklist is empty.')

  // A bad call is refused with the reason.
  expect((await $.tool.call({ tool: TOOL, action: 'done', id: '9' })).deny).toBe('No item 9.')
  expect((await $.tool.call({ tool: TOOL, action: 'frobnicate' })).deny).toContain('Unknown action')
})

test('each project keeps its own list', async ($, on) => {
  const { setProject } = stubEngine(on, '/work/alpha')
  await $.session.start(START)
  await run($, 'add Alpha only')

  // A session in another repository: the engine answers a different root.
  setProject('/work/beta')
  await $.session.start({ ...START, cwd: '/work/beta' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /open of/ }))?.text).toBe('0 open of 0')
  expect(await row(ui, '1')).toBeUndefined()
  await ui.unmount()

  expect((await run($, 'add Beta only')).text).toBe('Added 1. Beta only')
  expect((await run($, 'done 1')).text).toBe('1. Beta only is now done.')

  // Back in the first project, its list is untouched and beta's is unseen.
  setProject('/work/alpha')
  await $.session.start(START)
  const alpha = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await alpha.find({ type: 'Text', text: /open of/ }))?.text).toBe('1 open of 1')
  expect((await row(alpha, '1'))?.text).toBe('[ ] 1. Alpha only')
  expect(await alpha.find({ type: 'Text', text: /Beta only/ })).toBeUndefined()
  await alpha.unmount()
  expect((await run($, 'add Alpha again')).text).toBe('Added 2. Alpha again')
})

test('a list saved by an earlier session is read back and opens the pane', async ($, on) => {
  const saved = {
    'project:/work/alpha': {
      next: 4,
      items: [
        { id: '1', title: 'Kept open', status: 'open', detail: 'from last time' },
        { id: '3', title: 'Kept done', status: 'done' },
      ],
    },
  }
  const { opened } = stubEngine(on, '/work/alpha', saved)
  await $.session.start(START)
  expect(opened).toEqual(['checklist'])

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /open of/ }))?.text).toBe('1 open of 2')
  expect((await row(ui, '3'))?.text).toBe('[x] 3. Kept done')
  expect((await ui.find({ type: 'Text', text: /from last time/ }))?.text).toContain('from last time')
  await ui.unmount()

  // The gap an earlier session left is filled first, in its place; then the list carries on.
  expect((await run($, 'add New this session')).text).toBe('Added 2. New this session')
  expect((await run($, 'add And another')).text).toBe('Added 4. And another')
  expect((await $.tool.call({ tool: TOOL, action: 'list' })).result).toBe(
    '[ ] 1. Kept open -- from last time\n[ ] 2. New this session\n[x] 3. Kept done\n[ ] 4. And another',
  )
})

test('a shell cd during the session keeps the list where it was', async ($, on) => {
  const { setShellDir } = stubEngine(on, '/work/alpha')
  await $.session.start(START)
  await run($, 'add Before the cd')

  // The shell leaves the repository: git answers nothing, but the session's root has not moved.
  setShellDir(null)
  expect((await run($, 'add After leaving')).text).toBe('Added 2. After leaving')
  // Into another repository: still the same list.
  setShellDir('/work/beta')
  expect((await $.tool.call({ tool: TOOL, action: 'list' })).result).toBe(
    '[ ] 1. Before the cd\n[ ] 2. After leaving',
  )
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /open of/ }))?.text).toBe('2 open of 2')
  await ui.press({ key: 'item:1' })
  expect((await row(ui, '1'))?.text).toBe('[x] 1. Before the cd')
  await ui.unmount()

  // A reload runs session.start again from the moved shell: the list stays put.
  await $.session.start(START)
  expect((await $.tool.call({ tool: TOOL, action: 'list' })).result).toBe(
    '[x] 1. Before the cd\n[ ] 2. After leaving',
  )
})

test('a /cd to another project follows it to that project\'s list', async ($, on) => {
  const { setProject } = stubEngine(on, '/work/alpha')
  await $.session.start(START)
  await run($, 'add Alpha only')

  // /cd moves the session's root, with no new session.start.
  setProject('/work/beta')
  expect((await $.tool.call({ tool: TOOL, action: 'list' })).result).toBe('The checklist is empty.')
  expect((await run($, 'add Beta only')).text).toBe('Added 1. Beta only')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await row(ui, '1'))?.text).toBe('[ ] 1. Beta only')
  await ui.unmount()

  setProject('/work/alpha')
  expect((await $.tool.call({ tool: TOOL, action: 'list' })).result).toBe('[ ] 1. Alpha only')
})

test('/checklist version prints the version in the plugin\'s own manifest', async ($, on) => {
  stubEngine(on)
  const read: string[] = []
  on('fs.read', (_, e) => {
    read.push(e.path)
    return { value: JSON.stringify({ name: 'checklist', version: '9.8.7' }) }
  })
  await $.session.start(START)

  expect((await run($, 'version')).text).toBe('checklist 9.8.7')
  expect(read).toHaveLength(1)
  expect(read[0]).toEndWith('/.claude-plugin/plugin.json')
  expect((await run($, 'version now')).text).toContain('/checklist [add <title>')
})

const toolRow = (input: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  plugin: 'checklist',
  component: 'ToolUse',
  requestId: 'toolu_1',
  props: { tool_use_id: 'toolu_1', tool: TOOL, input, isRunning: false, isErrored: false, isInterrupted: false, ...extra },
  surface: 'terminal',
} as const)
const resultBlock = (output: unknown, extra: Record<string, unknown> = {}) => ({
  plugin: 'checklist',
  component: 'ToolResult',
  requestId: 'toolu_1',
  props: { tool_use_id: 'toolu_1', tool: TOOL, output, isErrored: false, ...extra },
  surface: 'terminal',
} as const)
const textOf = async (ui: any) => (await ui.find({ type: 'Text', text: /\S/ }))?.text

test('a checklist tool call is drawn as one short line', async ($, on) => {
  stubEngine(on)
  await $.session.start(START)

  for (const [input, line] of [
    [{ action: 'add', title: 'Write the README', detail: 'a long detail the row leaves out' }, 'Checklist · add "Write the README"'],
    [{ action: 'done', id: '3' }, 'Checklist · done 3'],
    [{ action: 'edit', id: '2', title: 'Renamed' }, 'Checklist · edit 2 "Renamed"'],
    [{ action: 'list' }, 'Checklist · list'],
  ] as const) {
    const ui = await $.ui.mount(toolRow(input))
    expect(await textOf(ui)).toBe(line)
    await ui.unmount()
  }
})

test('a checklist tool result shows its first line, or a count for a list', async ($, on) => {
  stubEngine(on)
  await $.session.start(START)

  const added = await $.ui.mount(resultBlock('Added 3. Write the README\n[ ] 1. One\n[x] 2. Two\n[ ] 3. Write the README'))
  expect(await textOf(added)).toBe('Added 3. Write the README')
  expect(await added.find({ type: 'Text', text: /One/ })).toBeUndefined()
  await added.unmount()

  const listed = await $.ui.mount(resultBlock('[ ] 1. One -- a detail\n[x] 2. Two\n[-] 3. Three\n[~] 4. Removed'))
  expect(await textOf(listed)).toBe('3 items, 1 open')
  await listed.unmount()

  const empty = await $.ui.mount(resultBlock('The checklist is empty.'))
  expect(await textOf(empty)).toBe('The checklist is empty.')
  await empty.unmount()
})

test('the expanded view and errors keep the engine\'s full drawing', async ($, on) => {
  stubEngine(on)
  await $.session.start(START)

  const row = await $.ui.mount(toolRow({ action: 'done', id: '3' }, { isExpanded: true }))
  expect(await row.find({ type: 'Text', text: 'Checklist · done 3' })).toBeUndefined()
  await row.unmount()

  const full = '1. One is now done.\n[x] 1. One'
  const expanded = await $.ui.mount(resultBlock(full, { isExpanded: true }))
  expect(await expanded.find({ type: 'Text', text: '1. One is now done.' })).toBeUndefined()
  await expanded.unmount()

  const errored = await $.ui.mount(resultBlock('No item 9.', { isErrored: true }))
  expect(await errored.find({ type: 'Text', text: 'No item 9.' })).toBeUndefined()
  await errored.unmount()
})

test('a removed item is struck through, dim, and not reopened by a click', async ($, on) => {
  stubEngine(on)
  await $.session.start(START)
  await run($, 'add Keep me')
  await run($, 'add Typo item')
  await run($, 'remove 2')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await row(ui, '2')).toBeUndefined()
  const removed = await ui.find({ type: 'Text', text: /Typo item/ })
  expect(removed?.text).toBe('[~] 2. Typo item')
  expect(removed?.props).toMatchObject({ dimColor: true })
  expect(removed?.children.at(-1)).toMatchObject({ props: { strikethrough: true }, children: ['2. Typo item'] })
  expect((await ui.find({ type: 'Text', text: /open of/ }))?.text).toBe('1 open of 1')
  await ui.unmount()
})
