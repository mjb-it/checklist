export type Status = 'open' | 'done' | 'dropped'

export type Item = {
  /** The item's own id: kept for its life and never handed out again. Claude names items by it. */
  uid: number
  title: string
  detail?: string
  status: Status
}

/** One project's checklist, as the store keeps it under `project:<root>`. */
export type Project = {
  /** The next uid to hand out. */
  next: number
  /** In list order: an item's position is its place here, from 1, with no gaps. */
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
