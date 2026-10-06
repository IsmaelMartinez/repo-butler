import { describe, expect, test, tier } from 'claude-code/testing'

tier('user')

const TOOL = 'mcp__repo-butler-comic__strip'

const panel = (scene: string, text: string) => ({
  scene,
  cast: [{ who: 'reginald', mood: 'calm' }],
  say: [{ who: 'reginald', text }],
})

const SCRIPT = {
  title: 'The Daily Butler Briefing',
  date: '7 October 2026',
  panels: [panel('morning-room', 'Good morning, sir.'), panel('fireside', 'All Gold.'), panel('study', 'Will that be all?')],
  stats: '14 repos * 14 Gold',
}

describe('register', () => {
  test('session start registers the strip tool with its script schema', async ($, on) => {
    const registered: { name: string; inputSchema?: Record<string, unknown> }[] = []
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('tool.register', ($, e) => {
      registered.push(e)
      return { value: { tool: `mcp__repo-butler-comic__${e.name}` } }
    })

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

    expect(registered.map(t => t.name)).toEqual(['strip'])
    expect(registered[0]?.inputSchema).toMatchObject({ required: ['title', 'date', 'panels', 'stats'] })
  })

  test('a script that fits is accepted and kept for the drawing', async $ => {
    const answer = await $.tool.call({ tool: TOOL, ...SCRIPT })

    expect(answer.deny).toBeUndefined()
    expect(typeof answer.result).toBe('string')
    expect(JSON.parse(answer.result as string)).toMatchObject({ drawn: true, script: { title: SCRIPT.title } })
  })

  test('words that overflow a panel are refused naming the panel', async $ => {
    const long = 'Sir, '.repeat(80)
    const answer = await $.tool.call({ tool: TOOL, ...SCRIPT, panels: [panel('kitchen', long), SCRIPT.panels[1], SCRIPT.panels[2]] })

    expect(answer.deny).toContain('panel 1')
  })

  test('the accepted strip draws three rasters side by side on a wide terminal', async $ => {
    const ui = await $.ui.mount({
      plugin: 'repo-butler-comic',
      surface: 'terminal',
      component: 'ToolResult',
      props: { tool_use_id: 't1', tool: TOOL, output: JSON.stringify({ drawn: true, script: SCRIPT }), isErrored: false },
      viewport: { columns: 160, rows: 50 },
    })

    expect(await ui.findAll({ type: 'Raster' })).toHaveLength(3)
    expect(await ui.find({ type: 'Text', text: /THE DAILY BUTLER BRIEFING/ })).toBeDefined()
    await ui.unmount()
  })

  test('another tool result is left to the engine', async ($, on) => {
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return h(Text, {}, 'the engine row')
    })
    const ui = await $.ui.mount({
      plugin: 'repo-butler-comic',
      surface: 'terminal',
      component: 'ToolResult',
      props: { tool_use_id: 't2', tool: 'mcp__other__strip', output: JSON.stringify({ script: SCRIPT }), isErrored: false },
      viewport: { columns: 160, rows: 50 },
    })

    expect(await ui.findAll({ type: 'Raster' })).toHaveLength(0)
    expect(await ui.find({ text: /the engine row/ })).toBeDefined()
    await ui.unmount()
  })
})
