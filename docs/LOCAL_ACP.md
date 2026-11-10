# Local ACP experiment

This branch adds ACP model access and a standalone local conversation backend.
The original model/Intelligence configuration remains available.

## Feature and harness analysis

OpenDots is a workspace for named specialist Dots, rather than OpenMuse's
single personal assistant. Each Dot has role instructions and independently
granted Space, memory, research, app, connection, and computer permissions.
Spaces contain editable Markdown pages with revisions, nested navigation,
autosave, page-specific conversations, and conversation-to-page saving.

The original harness is `DotAgent`: it assembles authorized tools and current
page context, streams through TanStack AI, checks permission changes during
execution, and exposes human review tools to the web app. `Platform` connects
this to CopilotKit Intelligence history, Channels, voice compute, and scheduled
turns. `Runner` supplies leases, interruption handling, and explicit retries.

Compared with Kirodex's coding-provider host, OpenDots supplies a document
workspace and service-action workflows. Its host permissions and owner review
must continue governing tool execution when a coding CLI supplies inference.
ACP does not replace these checks or supply the application's optional services.

| Feature                                       | Behavior with local ACP and local history                                   |
| --------------------------------------------- | --------------------------------------------------------------------------- |
| Spaces, page editor, revisions, library       | Existing SQLite implementation                                              |
| Specialist chat and page conversations        | ACP with persistent SQLite transcripts                                      |
| Dot instructions, memory, permissions         | Existing assembly and runtime checks                                        |
| Page and connection review cards              | Existing owner UI; provider pauses for its result                           |
| Scheduled work                                | SSE headless turns in the original local conversation                       |
| Research, MCP connections, connected apps     | Existing tools; configured services still needed                            |
| Isolated Dot computers                        | Existing OpenBot integration; separately configured                         |
| Calls                                         | Compute can use ACP/local history; realtime speech still needs its provider |
| Slack Channels                                | Requires Intelligence storage; unavailable in standalone local mode         |
| Automatic Learning and learned-skill delivery | Existing model/Intelligence path; not added to ACP                          |

## Run

Use Node 24 and the installed provider CLI on your PATH:

```sh
npm ci
cp .env.example .env
```

Add these settings to `.env`:

```dotenv
AGENT_BACKEND=acp
THREAD_STORAGE=local
ACP_PROVIDER=codex
AGENT_RUN_TIMEOUT_MS=300000
COPILOTKIT_TELEMETRY_DISABLED=true
WEB_SEARCH_PROVIDER=disabled
```

Then run `npm run dev` and open `http://127.0.0.1:5173`.
The API listens on `http://127.0.0.1:4310`.
Create a Dot conversation and ask it to list your authorized Spaces or create a
fictional page. Page chat, owner review, and scheduling use the same local history.

Select `ACP_PROVIDER=codex`, `claude`, or `kiro` and restart the API to change
providers. Codex and Claude ACP adapters are pinned dependencies; Kiro exposes
ACP directly. The application prefers installed CLIs over the adapters' bundled
public CLIs so existing CLI authentication is retained.

`ACP_MODEL` optionally selects a model. `ACP_COMMAND` and `ACP_ARGS` (a JSON
string array) select a custom ACP executable; no shell expansion is performed.
Custom executables are trusted programs and must enforce their own restrictions.

Production build/start: `npm run build`, then `npm start`.
The build copies the stdio MCP bridge beside the compiled server.

## Sessions, storage, and controls

Normal replies reuse one provider process/session per owner, Dot, and
conversation. Only new messages and current application context are sent on
subsequent turns. Changed Dot permissions, tools, instructions, or memory
invalidate that session.

At most two sessions are retained per application process. Idle sessions expire
after ten minutes or are replaced when another conversation needs a slot.
Additional concurrent turns receive a retryable error rather than starting an
unbounded number of providers.

The full transcript remains in SQLite. After a restart or eviction, a fresh ACP
session receives saved history. Restoration is limited to 96,000 UTF-8 bytes;
oversized history produces an explicit error, without deleting or silently
truncating messages. Provider context management applies inside a running
session. App-managed summaries and durable provider-session restoration remain
future work.
Changing storage modes does not migrate existing Intelligence conversations.

Human review emits the existing client tool call and ends the current run.
The app's owner review flow supplies its tool result on continuation. The
provider session is recreated at that boundary; no hidden provider turn remains
waiting indefinitely for approval. Scheduled/headless turns do not offer client
approval tools.

CLI child processes receive an allowlisted environment containing runtime
settings and model authentication, excluding OpenDots application and connector
credentials. Each session's authenticated MCP bridge binds only to loopback,
validates arguments, and invokes existing permission-checked application tools.
Native provider permission requests are declined without trusting tool titles.

Codex uses a private temporary `CODEX_HOME` containing model-access configuration
and credentials only. Global MCP servers, hooks, projects, and plugins are not
copied; shell, patch, JavaScript, image-generation, and delegation features are
disabled. Claude has an empty native-tool list, strict MCP configuration, and no
user/project setting sources; only model/authentication settings are carried.
Kiro receives an OpenDots-only temporary agent.

These are provider configuration controls, not an operating-system sandbox.
Actual computer work still goes through separately configured isolated
OpenBot computers. Temporary CLI authentication files are removed on session
cleanup. Local data, `.env`, build output, and diagnostics are Git-ignored.

“Local” describes the harness and history storage. Model input still goes to
the service used by the chosen CLI. Realtime speech, research, connected apps,
and other optional services have their own data handling when enabled.

## Verification

Run `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build`.
Protocol fixtures exercise the real ACP JSON-RPC and MCP stdio boundaries,
credential filtering, argument validation, native permission rejection,
session reuse and invalidation, process limits, approval continuation, and
client-validated replay after restarting the database.

Actual installed-provider checks:

```sh
ACP_PROVIDER=codex npm run acp:smoke
ACP_PROVIDER=claude npm run acp:smoke
ACP_PROVIDER=kiro npm run acp:smoke
```

These checks invoke model services and verify a real tool result and subsequent
session recall. Provider refusals or service failures remain failures, not
successful fixture results. No Slack message or connected-account action is
part of the smoke checks.

Local verification on November 10, 2026: Codex and Kiro completed both stages.
Claude completed the application tool round trip, but the installed default
model blocked the follow-up recall request. Full Claude session-recall
verification remains unresolved; the local application uses Codex.

Live AG-UI/HTTP checks also verified Codex page creation and read-back,
follow-up context, saved-history replay after API restart, a scheduled page
edit, and owner approval followed by continuation without a duplicate save.
Verification created fictional pages in the local workspace.

All 365 tests, typecheck, lint, formatting, and production build passed.
Both Knip modes retain the exact baseline findings (unused upstream exports,
one type, and one development dependency in the normal mode); the ACP change
adds no new findings. Live voice, Slack, connected accounts, research, and
OpenBot computers were not exercised in this local verification.
