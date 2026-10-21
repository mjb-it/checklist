# checklist

A Claude Code pane beside the chat that lists a checklist for the project
you are in: each item has a number, a title, an optional one-line detail,
and a status of open, done, or dropped. Every project (git root, or the
session's directory outside one) keeps its own list in the plugin's store,
so one repository never sees another's items. The pane opens by itself at
session start only when the project already has items.

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

## Developing

```
claude plugin validate <this folder>
claude plugin test <this folder>
```
