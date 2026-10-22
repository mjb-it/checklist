export type Status = 'open' | 'done' | 'dropped'

export type Item = {
  id: string
  title: string
  detail?: string
  status: Status
}

/** One project's checklist, as the store keeps it under `project:<root>`. */
export type Project = {
  /** The next id to hand out. */
  next: number
  items: Item[]
}

declare module 'claude-code' {
  interface PluginState {
    checklist: {
      /** The project the session is in, the session root it was worked out from, and its live list. */
      list: { project: string; root: string; items: Item[] }
    }
  }
}
