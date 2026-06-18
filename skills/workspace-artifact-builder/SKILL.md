---
name: workspace-artifact-builder
description: Create, revise, preview, or continue user-visible artifacts in the OpenClaw workspace. Use when the user asks for an artifact, canvas, previewable result, mini app, HTML page, prototype, report, mockup, generated file set, or when they ask to revise or continue an existing artifact that should be inspectable through the Workspace Artifacts plugin.
---

# Workspace Artifact Builder

## Core Contract

When the user asks to create, revise, preview, or continue an artifact:

- Create or update files under `workspace/artifacts/<artifact-id>/`.
- Keep artifact metadata in `workspace/artifacts/<artifact-id>/artifact.json`.
- For web artifacts, mirror runnable files to `workspace/canvas/<artifact-id>/`.
- Return a short summary and preview URLs.
- If the user explicitly asks for an Artifact, Workspace Artifacts preview,
  canvas, or URL-openable result, the response must include a Gateway URL that
  opens the artifact through the Workspace Artifacts plugin.
- Do not paste the full artifact body into chat when a preview URL is the
  requested deliverable.
- Never overwrite an existing artifact unless the user clearly asks for a revision.

## Fast Path for New Web Artifacts

When the user asks for a new small web/HTML Artifact and gives an explicit
`artifact-id`, do not browse the workspace first. Create the artifact directly:

1. `mkdir -p artifacts/<artifact-id> canvas/<artifact-id>`
2. write `artifacts/<artifact-id>/index.html` with a POSIX-safe heredoc
3. copy or write the same `index.html` to `canvas/<artifact-id>/index.html`
4. write `artifacts/<artifact-id>/artifact.json`
5. return the Workspace Artifacts URL

Do not use the shell built-in `test` for Artifact existence checks in OpenClaw
sandboxes; sandbox policy may decline that command. If you must inspect, use
`find`, `ls`, or `sed` on a narrow path under `/workspace`, then continue.
Avoid broad discovery commands such as `rg --files /workspace` or
`find /home/yasu/.openclaw` for simple Artifact creation.

## Paths

Resolve the OpenClaw workspace root before writing. Prefer the configured OpenClaw workspace when available; otherwise use `~/.openclaw/workspace`.

When running inside an OpenClaw sandbox, host paths such as
`~/.openclaw/skills/<skill>/SKILL.md` may not exist. If you need to inspect this
skill file from the sandbox, read
`/workspace/.openclaw/sandbox-skills/skills/workspace-artifact-builder/SKILL.md`
first. Do not spend time searching the whole filesystem for the skill file when
the current task can be completed from the instructions already injected into
the prompt.

Use these paths relative to the workspace root:

- Artifact source: `artifacts/<artifact-id>/`
- Artifact metadata: `artifacts/<artifact-id>/artifact.json`
- Web preview mirror: `canvas/<artifact-id>/`

Use a stable, readable `artifact-id`: lowercase letters, digits, and hyphens only. Derive it from the user request, for example `pricing-dashboard`, `landing-page-v1`, or `meeting-notes-summary`. If the target artifact already exists and the user did not ask to revise it, choose a new suffix such as `-v2`.

## Metadata

Create or update `artifact.json` with at least:

```json
{
  "id": "artifact-id",
  "title": "Human readable title",
  "type": "web",
  "createdAt": "2026-06-11T00:00:00.000Z",
  "updatedAt": "2026-06-11T00:00:00.000Z",
  "entry": "index.html",
  "summary": "Short description of the artifact."
}
```

Preserve `createdAt` when revising. Update `updatedAt` on every change. Use ISO 8601 timestamps.

Set `type` to:

- `web` for previewable HTML/CSS/JS artifacts.
- `document` for markdown, text, or structured documents.
- `data` for JSON/CSV or dataset artifacts.
- `mixed` when the artifact includes several kinds.

## Creation Workflow

1. Determine whether this is a new artifact or a revision.
2. Choose `artifact-id` and check whether `artifacts/<artifact-id>/` already exists.
3. If it exists and the user did not ask for revision, create a new id instead of overwriting.
4. Write the artifact source files.
5. Write or update `artifact.json`.
6. For `type: "web"`, mirror the runnable files to `canvas/<artifact-id>/`.
7. Validate that the entry file exists.
8. Run the quality checks below and revise obvious problems before responding.
9. Return a concise summary and preview URLs.

Use the available file-writing tool directly when it supports full file
contents. If the runtime only exposes shell-style commands, create artifact
files with POSIX-safe heredocs under the allowed artifact paths. Do not call an
`apply_patch` tool for new artifact files unless the tool schema clearly
includes the complete file contents to write; an empty add-file patch only
creates a failed run and does not satisfy the Artifact request.

When the user says "Artifact" for a long report, study pack, generated content,
or other result meant to be opened from Telegram or Slack, prefer a web
artifact with a readable `index.html` preview and mirror it to
`canvas/<artifact-id>/`. Optionally keep Markdown or data source files under
`artifacts/<artifact-id>/`, but make the primary entry previewable. Use
`type: "document"` or `type: "data"` only when the user explicitly asks for a
plain Markdown/text/data file or when a web preview would not add value.

## Quality Checks

Treat artifacts as user-visible deliverables, not rough code snippets.

For web artifacts:

- Do one explicit self-review pass after writing the first version.
- Check desktop and phone layouts in the code. Text, buttons, images, and animation layers must not overlap incoherently.
- Use stable responsive sizing for fixed-format surfaces such as stages, panels, grids, and controls.
- For animation artifacts, verify the animation has a clear beginning, middle, and end; avoid a single static scene with superficial motion.
- Include reduced-motion handling or a non-animated fallback when practical.
- Prefer real provided assets for brand/product/logo work. Do not approximate a provided logo with generic shapes when the asset is available.
- If browser, screenshot, or DOM tooling is available, preview the entry file before responding and fix visible issues. If visual preview is not available, inspect the HTML/CSS/JS manually and avoid claiming visual verification.
- Before final response, ensure the canvas mirror contains every runtime file referenced by the entry file.

## Web Artifacts

For previewable web artifacts, make `index.html` the default entry unless there is a clear reason not to.

Use plain HTML/CSS/JS when the artifact can be self-contained. Avoid adding a build step unless the user requests a framework or the artifact truly needs one.

Mirror these files from `artifacts/<artifact-id>/` to `canvas/<artifact-id>/`:

- `index.html`
- CSS, JS, images, fonts, and data files needed by the page
- Any relative assets referenced by the entry file

Do not mirror `artifact.json` unless it is intentionally part of the artifact runtime.

Always provide both preview URLs as tap-friendly Markdown links with the URL repeated after the link. Chat channels such as Telegram and Slack should receive a clickable label when Markdown is rendered, while still exposing the raw URL when Markdown is not rendered.

```text
Local: [Open locally](http://127.0.0.1:<gateway-port>/plugins/workspace-artifacts/?file=canvas/<artifact-id>/index.html) - http://127.0.0.1:<gateway-port>/plugins/workspace-artifacts/?file=canvas/<artifact-id>/index.html
Tailscale: [Open from phone](<tailscale-serve-origin>/plugins/workspace-artifacts/?file=canvas/<artifact-id>/index.html) - <tailscale-serve-origin>/plugins/workspace-artifacts/?file=canvas/<artifact-id>/index.html
```

Resolve `<gateway-port>` from OpenClaw config or status; default to `18789` when not configured. Resolve `<tailscale-serve-origin>` from current OpenClaw status/config when Tailscale Serve is enabled. If no Tailscale Serve origin is configured, still provide the Local URL and state that the Tailscale URL is unavailable.

## Document and Data Artifacts

If the artifact is intentionally `type: "document"` or `type: "data"` and no
canvas mirror exists, the Workspace Artifacts plugin can still open the source
entry directly. Return URLs that point at `artifacts/<artifact-id>/<entry>`:

```text
Local: [Open locally](http://127.0.0.1:<gateway-port>/plugins/workspace-artifacts/?file=artifacts/<artifact-id>/<entry>) - http://127.0.0.1:<gateway-port>/plugins/workspace-artifacts/?file=artifacts/<artifact-id>/<entry>
Tailscale: [Open from phone](<tailscale-serve-origin>/plugins/workspace-artifacts/?file=artifacts/<artifact-id>/<entry>) - <tailscale-serve-origin>/plugins/workspace-artifacts/?file=artifacts/<artifact-id>/<entry>
```

Use document/data URLs only as the fallback for intentionally non-web
artifacts. For a user-facing "Artifact" request without a plain-file
constraint, create the web preview instead.

## Revision Rules

Treat these as clear revision requests:

- "revise this artifact"
- "update the previous artifact"
- "continue `<artifact-id>`"
- "change the page we just made"
- "edit `artifacts/<artifact-id>`"

When revising:

- Read existing `artifact.json` first.
- Preserve unrelated files.
- Update only files needed for the requested change.
- Preserve `createdAt`; update `updatedAt`.
- Keep the same `artifact-id` unless the user asks for a new variant.

When the user is ambiguous, avoid destructive overwrites. Create a new variant and mention the original was left untouched.

## Safety

Never place secrets, tokens, `.env` files, private keys, `.git` contents, or credential files inside an artifact or canvas mirror.

Do not write outside the workspace artifact paths unless the user explicitly asks and the task requires it.

For generated HTML, avoid remote scripts by default. Use local assets or simple inline code unless the user requests external dependencies.

## Response Format

Keep the final response short:

```text
Created <title> at artifacts/<artifact-id>/.
Preview:
Local: [Open locally](http://127.0.0.1:<gateway-port>/plugins/workspace-artifacts/?file=canvas/<artifact-id>/index.html) - http://127.0.0.1:<gateway-port>/plugins/workspace-artifacts/?file=canvas/<artifact-id>/index.html
Tailscale: [Open from phone](<tailscale-serve-origin>/plugins/workspace-artifacts/?file=canvas/<artifact-id>/index.html) - <tailscale-serve-origin>/plugins/workspace-artifacts/?file=canvas/<artifact-id>/index.html
Entry: canvas/<artifact-id>/index.html
```

For intentional document or data artifacts, replace the `canvas/.../index.html`
paths above with `artifacts/<artifact-id>/<entry>`.

Include any important limitation, such as "static preview only" or "Tailscale URL unavailable because Serve is not configured".
