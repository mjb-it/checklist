# checklist

A Claude Code pane beside the chat that lists a checklist for the session
you are in: each item has a number, a title, an optional one-line detail,
and a status of open, done, or dropped. Every session keeps its own list in
the plugin's store, so two sessions in the same directory never see or
change each other's items. The list stays with its session: through a `cd`
or a `/cd`, a plugin reload, and a `/clear`, which carries it over to the
fresh conversation, and `claude --resume` brings it back. A list no session
has touched for 90 days is deleted. The pane opens by itself at session
start only when the session already has items.

Lists from before 0.7.0 were kept per project: the first session to start
in a project takes that project's list as its own, and later ones start
empty.

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
/plugin install checklist --marketplace mjb-it/checklist
```

Answer `y` to add the marketplace, then pick a scope (user is the usual one).

From a shell:

```
claude plugin install checklist --marketplace mjb-it/checklist
```

In the desktop app, where `/plugin` does not run: click + next to the prompt
box, then Plugins, Add marketplace with `mjb-it/checklist`, then Add plugin.

## Usage

At the prompt:

```
/checklist                              open the pane
/checklist add <title> [-- detail]      add an item at the end
/checklist done <n>                     mark item n done      [x]
/checklist open <n>                     mark item n open      [ ]
/checklist drop <n>                     mark item n dropped   [-]
/checklist edit <n> <title>             retitle item n
/checklist remove <n>                   delete item n; the ones after it move up
/checklist clear                        delete every item; reports what it removed
/checklist close                        close the pane
/checklist version                      print the installed plugin's version
```

Anything else prints one line of usage.

An item's number is its place in the list, so the numbers always run 1, 2,
3 with no gaps: removing one moves the items after it up a place.

The pane shows a header like `3 open of 10`, then every item in order: open
items bold, done items dim, dropped items struck through. The detail shows
on a dim second line when the pane is at least 56 columns wide.

A click on a row toggles it: an open item becomes done, a done or dropped
item becomes open. Clicks reach the pane in the fullscreen terminal and in
the desktop app.

## The Claude session can use it too

The plugin registers a `checklist` tool the model can call, so you can say
"add that to the checklist" or "mark 3 done" in the chat, and Claude can
tick items off as it finishes them. It writes the same session list the
command and the pane use.

Besides its number, each item has an id that only Claude sees (`#12`): it
never changes and is never given to another item, so Claude's hold on an
item survives the numbers moving. Claude names an item by id when it is
tracking it, and by position when it repeats a number you gave; a position
is read against the list as it is at that moment, which is the list you
see. The tool takes an `action` (`list`, `add`, `done`, `open`, `drop`,
`edit`, `remove`, `clear`) with `id` or `position`, `title` and `detail` as
the action needs. A change answers with the one item it touched
(`3. Ship it (#12) is now done.`); `list` answers with every item.

In the transcript each of those calls is one line, like `Checklist · done 3`,
with one line of result (`3. Ship it is now done.`, or `4 items, 2 open` for
a list), and never an id. ctrl+o shows the calls in full.

## How it hooks Claude Code

The plugin is a mod: one hooks module, `hooks/register.tsx`, and nothing
else runs. What it hooks, and what each hook touches:

- **`session.start`** registers the `/checklist` command and the `checklist`
  tool, reads this session's list from the plugin's own store, and opens the
  pane when the list is not empty. It also deletes lists untouched for 90
  days. It then passes the event on unchanged.
- **`session.end`**: on a `/clear`, marks the list to move to the session id
  the conversation goes on under. It changes nothing else, and passes the
  event on unchanged.
- **`prompt.submit`**: checks that the live list is this session's, in case
  a `/clear` or a switch of session changed the session id. It reads the
  prompt not at all, and passes it on unchanged.
- **`command.run`**, matched to `command: "checklist"` only. It answers
  `/checklist` itself and never sees or changes any other command, whether a
  person typed it or another plugin ran it.
- **`tool.call`**, matched to `tool: "mcp__checklist__checklist"` only. That
  tool is the plugin's own, registered by this module, and no other code
  serves it, so the hook answers the call in place of a tool: it is the
  tool. It stands in for no built-in or MCP tool and never sees a call to
  one.
- **`ui.render`** for the `Pane` with the id `checklist`: draws the pane
  from the live list. Also for the `ToolUse` row and `ToolResult` block of
  a call to its own tool, matched to `tool: "mcp__checklist__checklist"`
  only: draws each as one line, and hands the expanded view (ctrl+o) and
  errors back to the engine. It draws nothing else.

The plugin reads and writes only its own store, under one key per session,
and its own state value; `/checklist version` also reads its own
`.claude-plugin/plugin.json`. It makes no network requests and runs no
processes.

## Developing

```
claude plugin validate <this folder>
claude plugin test <this folder>
```
