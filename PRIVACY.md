# Privacy Policy

Last updated: October 15, 2026

Ibintec Premiere MCP is local software that runs on your own computer. Ibintec
Limited does not operate a hosted service for it and does not receive your
Premiere projects, media, requests, or tool results.

## Local data

The MCP server and the CEP bridge panel exchange command and response files in
a local bridge folder you choose. These files can contain project names,
sequence names, media paths, and tool arguments and results. The panel can also
write a local diagnostics file when you run diagnostics. This data stays on
your computer unless you choose to share it.

## Images sent to your AI client

The vision tools (`view_clip`, `view_moment`, `view_timeline`,
`render_title_card`) read frames from your video files or your Premiere
sequence and **return them as images to the AI client that called the tool**,
so the AI can see the footage. If your AI client is a cloud service (for
example Claude), those images are sent to that service and are handled under
its privacy policy, as is everything else you share with it. Do not use the
vision tools on footage you are not willing to share with your AI provider.
Text-only tools likewise return project details (names, paths, timings) to
your AI client.

## Third parties

Downloading this project from GitHub, installing dependencies through npm,
using Adobe Premiere Pro or ffmpeg, and using an MCP client such as Claude
Desktop are governed by those providers' own terms and privacy policies.

## No analytics

Ibintec Premiere MCP does not include analytics or telemetry. It does not send
usage or project data to Ibintec Limited.

## Contact

For privacy questions, open an issue at https://github.com/ibintec/premiere-mcp/issues.
