# checklist

A Claude Code pane beside the chat that lists a checklist for the project
you are in: each item has a number, a title, an optional one-line detail,
and a status of open, done, or dropped. Every project (git root, or the
session's directory outside one) keeps its own list in the plugin's store,
so one repository never sees another's items. The pane opens by itself at
session start only when the project already has items.

## Requirements

Claude Code **2.1.287 or later**: this is a mod (a plugin with a hooks
module), and earlier builds have no pane, no command hook and no plugin
tools, so the plugin does not load there at all. The shell install form
below needs 2.1.292 or later. A session that reaches Claude through
Bedrock, Vertex or Foundry needs 2.1.304. Written against 2.1.306 and
tested on 2.1.296 and 2.1.306.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install checklist --marketplace mjb-it/punchlist
```

Answer `y` to add the marketplace, then pick a scope (user is the usual one).

From a shell:

```
claude plugin install checklist --marketplace mjb-it/punchlist
```

In the desktop app, where `/plugin` does not run: click + next to the prompt
box, then Plugins, Add marketplace with `mjb-it/punchlist`, then Add plugin.

## Usage

At the prompt:

```
/checklist                              open the pane
/checklist add <title> [-- detail]      add an item (numbered in order)
/checklist done <id>                    mark an item done     [x]
/checklist open <id>                    mark an item open     [ ]
/checklist drop <id>                    mark an item dropped  [-]
/checklist edit <id> <title>            retitle an item
/checklist remove <id>                  delete an item (its id is not reused)
/checklist clear                        delete every item; reports what it removed
/checklist close                        close the pane
```

Anything else prints one line of usage.

The pane shows a header like `3 open of 10`, then every item in order: open
items bold, done items dim, dropped items struck through. The detail shows on
a dim second line when the pane is at least 56 columns wide.

A click on a row toggles it: an open item becomes done, a done or dropped
item becomes open. Clicks reach the pane in the fullscreen terminal and in
the desktop app.

## The Claude session can use it too

The plugin registers a `checklist` tool the model can call, so you can say
"add that to the checklist" or "mark 3 done" in the chat, and Claude can
tick items off as it finishes them. The tool takes an `action` (`list`,
`add`, `done`, `open`, `drop`, `edit`, `remove`, `clear`) with `id`,
`title` and `detail` as the action needs, and answers with the whole list as text.
It writes the same per-project list the command and the pane use.

## How it hooks Claude Code

The plugin is a mod: one hooks module, `hooks/register.tsx`, and nothing
else runs. What it hooks, and what each hook touches:

- **`session.start`** registers the `/checklist` command and the `checklist`
  tool, reads this project's list from the plugin's own store, and opens the
  pane when the list is not empty. It then passes the event on unchanged.
- **`command.run`**, matched to `command: "checklist"` only. It answers
  `/checklist` itself and never sees or changes any other command, whether a
  person typed it or another plugin ran it.
- **`tool.call`**, matched to `tool: "mcp__checklist__checklist"` only. That
  tool is the plugin's own, registered by this module, and no other code
  serves it, so the hook answers the call in place of a tool: it is the
  tool. It stands in for no built-in or MCP tool and never sees a call to
  one.
- **`ui.render`** for the `Pane` with the id `checklist`: draws the pane
  from the live list. It draws nothing else.

The plugin reads and writes only its own store, under one key per project,
and its own state value. It makes no network requests and runs no
processes.

## Developing

```
claude plugin validate <this folder>
claude plugin test <this folder>
```
