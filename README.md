# Teyoo

> A free, elegant Markdown editor anyone can pick up. No toolbars, no clutter, and the file on disk is always what you see.

Teyoo is an open-source, free, elegant Markdown editor for writing, notes, and documentation. It is built for people who just want to write: no toolbars, no status bar, nothing to configure: just your text and a file list, with a tab strip only when you open a second document.

It offers true WYSIWYG editing, 12 built-in themes, rich-text copy, smart line breaks, search and replace, a document outline, PDF / HTML / Word export, and runs on Windows.

Whatever writes the file (an AI agent such as Claude Code or Codex, a script, or another editor), Teyoo shows the new content right away. No reopening, no manual refresh.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub release](https://img.shields.io/github/release/xxoolqq/Teyoo.svg)](https://github.com/xxoolqq/Teyoo/releases)

[Download](#download) | [Features](#features)

---

## Screenshots

<p align="center">
  <img src="docs/images/tasks-en.png" alt="Teyoo showing an interactive task list" width="49%">
  <img src="docs/images/rendering-en.png" alt="Teyoo rendering a table and inline code" width="49%">
</p>

<p align="center"><em>Interactive task lists, and Markdown rendered as you type: headings, links, tables and inline code.</em></p>

## Themes

Twelve built-in themes, six light, six dark, inspired by Bear, Notion, iA Writer, Kindle, Solarized, Nord, Gruvbox, and Dracula. Every one of them is also a standalone CSS file in [`themes/`](themes/), with a guide to [writing your own](themes/README.md).

<p align="center">
  <img src="docs/images/theme-swatches.svg" alt="Teyoo themes" width="92%">
</p>

## Features

- **Always in Sync**: Whenever the file changes on disk (an AI agent, a script, another editor), the editor updates immediately. No reopening, no manual refresh.
- **True WYSIWYG Editing**: Type Markdown and see rich text directly. No split-pane preview.
- **Files & Outline**: Browse Markdown files in the selected folder, or switch to a document outline for focused heading navigation.
- **Source Mode**: Switch to the raw Markdown source whenever you need to inspect or edit it directly.
- **Task Lists**: Click checkboxes to complete tasks, or use the keyboard shortcut.
- **Highlights & LaTeX**: Write `==highlighted text==` and render mathematical formulas with KaTeX.
- **Mermaid Diagrams**: Mermaid code blocks render as diagrams in an isolated hidden iframe with strict parsing; click a diagram to edit its source.
- **Search & Replace**: Find anything in the current document with ⌘/Ctrl+F, then replace the current match or all matches.
- **Smart Line Breaks**: Single newlines render as line breaks, matching how people and AI tools write Markdown.
- **Rich Text Copy**: Copy content with formatting preserved into WeChat, email, and other rich-text editors.
- **Themes**: Twelve built-in themes for focused writing in light or dark environments.
- **Recent Files & Session Restore**: Jump back to the last 10 documents from the File menu, and reopen where you left off at launch.
- **Editor Font Settings**: Pick any installed system font and size for the editor; your choice wins over theme defaults.
- **Multiple Windows**: Independent editor windows, each with its own save queue and close protection.
- **Save Status Hint**: A quiet titlebar indicator shows unsaved/saved, then fades away.
- **Heading Anchors**: Click intra-document anchor links to jump between headings, CJK included.
- **Version Changelog**: The first launch after an update opens the built-in changelog once, so you can see what changed without repeated prompts.
- **PDF, HTML & Word Export**: Turn your Markdown document into a themed PDF, self-contained HTML, or editable Word document.
- **Reading-Page Image Export**: Share Markdown as desktop or mobile PNG pages; longer documents continue as numbered pages.
- **Word Import**: Convert `.docx` into Markdown in place, keeping formulas, ruby annotations, tables and emphasis marks.
- **Formula Recognition**: Turn a screenshot of a formula into LaTeX with a local model, no network round-trip.
- **Portable Image Paths**: Local images use safe `file://` URLs for display and return to relative paths when saved.
- **In-App Updates**: New versions are found automatically, downloaded on request, and installed on quit.
- **Minimal by Design**: No toolbar, no permanent sidebar, no distractions.

## Works with your Markdown workflow

Teyoo does not ask you to change your habits. It works well alongside Obsidian, Typora, VS Code, and other Markdown apps, all sharing the same `.md` files, with each tool doing what it does best.

## Download

> Check [Releases](https://github.com/xxoolqq/Teyoo/releases) for the latest builds.

| Build | Format | Notes |
|-------|--------|-------|
| Installer | `Teyoo-Setup-<version>.exe` | Adds file associations, supports in-app updates |
| Portable  | `Teyoo-<version>-win-x64.zip` | Unzip anywhere and run; no file associations, no in-app updates |

Updating: install 7.9.0 or later once. From then on, new versions are offered inside the app and installed silently on quit. Coming from a previous, differently-named build? Uninstall it first: the two applications have separate identities and do not replace each other.

## Roadmap

- v7.9.0: The first release of the new Teyoo line (Windows installer with in-app updates, plus a portable zip build)
- Future: More themes, editor integrations, and smoother Markdown workflows

## License

[MIT](LICENSE), Free forever.

---

Teyoo is maintained by [orange2ai](https://github.com/orange2ai). Issues, ideas and pull requests are welcome.
