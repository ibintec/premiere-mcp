# Ibintec Premiere MCP

**AI video editing for Adobe Premiere Pro 20+, where the AI can see your footage.**

Ibintec Premiere MCP connects an AI client such as Claude Desktop to Adobe
Premiere Pro on your computer. The AI can look at your clips, choose the best
moments, build the edit on your timeline, render animated titles, check its own
work, and export.

It is based on the open-source
[adobe-premiere-mcp](https://github.com/compimprove/adobe-premiere-mcp) by
hetpatel-11 (MIT License), and adds vision and title tools by Ibintec Limited.
Not affiliated with or endorsed by Adobe.

[![License: MIT](https://img.shields.io/badge/License-MIT-5fd3c6.svg)](LICENSE.md)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933.svg)](https://nodejs.org/)

## What it can do

**Edit** (289 tools in total): create and organise projects, import media,
build sequences, place, trim, split and move clips, add transitions and effects,
adjust colour and audio, duck music under speech, add captions and markers,
reframe for vertical video, and export.

**See** (Ibintec additions):

| Tool | What it does |
|---|---|
| `list_clips` | Lists the video files in a folder with their durations |
| `view_clip` | Shows the AI a contact sheet of a whole clip (up to 24 frames) with exact timestamps |
| `view_moment` | Zooms in on one section of a clip to find the exact best moment or cut point |
| `view_timeline` | Shows the AI frames from your Premiere sequence, so it can review the edit it just made |
| `render_title_card` | Renders an animated title (slide up, slide left or fade) to a transparent `.mov` for intros and lower thirds, with a preview |

Example request to your AI client:

> List the clips in my Episode 5 proxies folder and look at each one. Build a
> 12-second hook from the best moments at the start of my sequence, add an
> animated "Rural African Homestead" title after it, then check the first 20
> seconds with view_timeline.

## Requirements

- Windows 10/11 or macOS
- Adobe Premiere Pro 2020 or newer
- [Node.js](https://nodejs.org/) 20 or newer
- ffmpeg and ffprobe on your PATH (Windows: `winget install Gyan.FFmpeg`;
  macOS: `brew install ffmpeg`)
- An MCP client on the same computer, such as Claude Desktop

## Install

### Windows

In PowerShell:

```powershell
git clone https://github.com/ibintec/premiere-mcp.git C:\Tools\premiere-mcp
cd C:\Tools\premiere-mcp
npm install
npm run build
npm install -g .
premiere-pro-mcp --install-cep
premiere-pro-mcp --doctor
```

`npm install -g .` links the `premiere-pro-mcp` command to this folder, so keep
the folder where it is. If PowerShell says running scripts is disabled, run
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once and try again.

### macOS

```bash
git clone https://github.com/ibintec/premiere-mcp.git
cd premiere-mcp
npm install
npm run build
npm install -g .
premiere-pro-mcp --install-cep
premiere-pro-mcp --doctor
```

### Connect Claude Desktop

The installer adds the server to Claude Desktop's configuration. If it does
not, open the config file (`%APPDATA%\Claude\claude_desktop_config.json` on
Windows, `~/Library/Application Support/Claude/claude_desktop_config.json` on
macOS) and add:

```json
{
  "mcpServers": {
    "premiere-pro": {
      "command": "premiere-pro-mcp"
    }
  }
}
```

Then fully quit and reopen Claude Desktop.

### Start the bridge in Premiere

1. Restart Premiere Pro and open a project.
2. Open **Window > Extensions > MCP Bridge (CEP)**. If it is missing, enable
   **Preferences > Plugins > Enable developer mode**, restart Premiere and look
   again.
3. Set the bridge directory shown by the installer, click **Save
   Configuration**, then **Start Bridge**.

### Check it works

Ask your AI client:

> Run verify_premiere_connection. Make no changes.

It should reply with your Premiere version and the open project.

## Tips

- **Name your clips descriptively** (`goats_feeding_wide.mp4` rather than
  `C0045.MP4`). It helps the AI even with vision.
- **Point the vision tools at proxies**, not 4K originals. They only need small
  frames, and proxies are much faster to read.
- **Images use more of your AI plan's capacity than text.** For long shoots,
  log the footage in batches of 15 to 20 clips per conversation.
- **Work on a copy of your project** and save often. Ctrl+Z (Cmd+Z) undoes
  changes, and the `undo` tool can too.
- **Match titles to your sequence.** Ask the AI to read the sequence settings
  first so `render_title_card` uses the same size and frame rate. Place the
  rendered `.mov` on a video track above your footage.

## Limits

- The vision tools show the AI **pictures, not sound**. For talking sections,
  use Premiere's Speech-to-Text transcript.
- The AI judges footage by sampled frames. It can miss quick moments between
  frames; use `view_moment` to look closer.
- Premiere's scripting interface does not expose every editing operation.
  See [KNOWN_ISSUES.md](KNOWN_ISSUES.md).
- The automation assembles and adjusts your footage; it does not replace your
  own editorial judgement. Review every edit before publishing.

## Troubleshooting

| Problem | Fix |
|---|---|
| Tools appear but every call times out | Open Premiere with a project loaded, open the MCP Bridge (CEP) panel, check the bridge directory and click Start Bridge |
| `premiere-pro-mcp` is not recognised | Open a new PowerShell window; check `npm install -g .` finished without errors |
| Vision tools say ffmpeg was not found | Install ffmpeg (see Requirements), then fully restart Claude Desktop so it picks up the new PATH |
| The panel is missing in Premiere | Enable developer mode under Preferences > Plugins and restart Premiere |
| Something else fails | Click **Run Diagnostics** in the panel and run `premiere-pro-mcp --doctor`; include both outputs in an issue |

More detail: [QUICKSTART.md](QUICKSTART.md).

## Privacy

Everything runs on your computer and Ibintec receives no data. The vision tools
send video frames to your AI client so it can see them. If that client is a
cloud service, the frames go to that service. See [PRIVACY.md](PRIVACY.md).

## License and credits

MIT License, see [LICENSE.md](LICENSE.md).

- Original project: adobe-premiere-mcp, copyright (c) 2025-2026 hetpatel-11
- Vision tools, title rendering and modifications: copyright (c) 2026 Ibintec
  Limited

See [CHANGELOG.md](CHANGELOG.md) for what changed from the original. Support:
[open an issue](https://github.com/ibintec/premiere-mcp/issues).
