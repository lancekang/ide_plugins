# WebStorm Merge GUI for VS Code & Cursor

A developer-friendly **3-Way Git Merge Conflict Resolver** that brings the beloved **WebStorm / IntelliJ IDEA merge experience** to **Visual Studio Code** and **Cursor**.

![Icon](media/icon.png)

## ✨ Features

- 🔀 **WebStorm 3-Way Merge Layout**:
  - **Left**: Current Branch (*Ours / Local*)
  - **Center**: Merged Result (*Directly Editable + Gutter Actions*)
  - **Right**: Incoming Branch (*Theirs / Remote*)
- 🔄 **Layout Switcher**: Toggle instantly between **Classic 3-Column** and **2-Row Split Layout** (Top: Compare, Bottom: Full-width Result editor).
- 🪄 **Magic Wand (Auto-Resolve)**: Automatically detects and applies all non-conflicting changes from both sides with one click!
- 🏹 **Gutter Quick-Action Buttons**:
  - `»` / `«` : Accept Local or Incoming change block into Result
  - `✕` : Ignore / Discard change block
- ⚡ **Git Staging Integration**:
  - `Apply & Save (git add)` button (or <kbd>Ctrl+S</kbd> / <kbd>Cmd+S</kbd>) automatically saves resolved output and runs `git add` to mark conflict as resolved.
- 🎯 **Conflict Navigation**:
  - <kbd>F7</kbd> / <kbd>Alt+Down</kbd>: Jump to Next Conflict
  - <kbd>Shift+F7</kbd> / <kbd>Alt+Up</kbd>: Jump to Previous Conflict
- 🔍 **Hybrid Conflict Detection**:
  - Reads Git index stages (`:1:` Base, `:2:` Ours, `:3:` Theirs) via Git CLI.
  - Automatically falls back to parsing Git conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`).
- 🔗 **Synchronized Scrolling**: Smoothly keep left, center, and right panes aligned.

## 🚀 How to Use

1. Open any file with conflict markers or click on a conflicted file in the Source Control view.
2. Click the **Resolve with WebStorm Merge GUI** button in the editor title bar, or press <kbd>Ctrl+Alt+M</kbd> (<kbd>Cmd+Alt+M</kbd> on macOS).
3. Alternatively, run **"WebStorm Merge: Find Conflicted Files"** from the Command Palette (`Ctrl+Shift+P`).
4. Click `»` or `«` on conflict blocks, or use **🪄 Magic Wand** to auto-merge non-conflicts.
5. Click **💾 Apply & Save (git add)** to complete!
