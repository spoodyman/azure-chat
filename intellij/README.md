# Azure History Chat for IntelliJ IDEA

The IntelliJ counterpart of the VS Code extension in this repository. It uses the same bundled chat UI and the same Azure history API. Requires IntelliJ IDEA 2024.3–2026.1, Community or Ultimate, running the bundled JetBrains Runtime with JCEF. IntelliJ IDEA 2020.1 is not supported.

## Install and connect

1. Build with `./gradlew test buildPlugin` (Windows: `.\gradlew.bat test buildPlugin`) using JDK 21 or newer.
2. In IntelliJ, open **Settings → Plugins → ⚙ → Install Plugin from Disk** and choose `build/distributions/azure-history-chat-intellij-0.1.5.zip`, then restart when prompted.
3. Open **View → Tool Windows → Azure Chat** and click **Connection**.
4. Enter the deployed Microsoft Azure OpenAI Chat sample application URL and a user bearer token accepted by its authentication layer. This is the application URL, not the Azure OpenAI resource endpoint. Tokens are stored in IntelliJ Password Safe, separately for each application URL, and are never passed to the embedded UI. Leave the token field blank to retain the token for that URL.
5. Select **POST** history reads for the Microsoft sample's `POST /history/read` endpoint, or **GET** for backends exposing `/history/read/{id}`.

Your deployed backend must authenticate the bearer token as a user and have Cosmos DB history configured. The plugin uses the backend's configured model and does not select a deployment. Backend configuration and authentication requirements are the same as [the VS Code extension](../README.md).

## Features

- Create, list, reopen, refresh, and delete chats, with confirmation before deletion.
- Stream JSON, NDJSON, SSE, or adjacent JSON replies. **Stop** cancels the request. After interrupted or failed generations, refresh and reopen history before sending again, since the backend may have stored the user message.
- Save complete conversations with backend IDs and metadata. **Retry saving reply** reuses the same assistant ID and excludes temporary skills. Switching chats and connections is blocked while a reply needs saving. Closing the project discards unsaved pending replies.
- **Pin current file** includes the latest editor text, including unsaved changes, on every request until removed. **Attach selection** is also available in the editor context menu and Find Action; selections include file names and line ranges and are consumed after sending. Click an attachment to remove it.
- Choose multiple Markdown or JSON skills from the project's root `skills/` folder and any additional external content roots. Nested folders, search, live editor changes, and creating skills are supported. Selected skill instructions enter generation as a temporary system message and never enter history updates.
- Skills and attachments share the configurable 200 KB default byte limit. Files, skills, and file proposals require a trusted local project.
- Render Markdown and highlighted code with **Copy reply** and **Copy code**. Raw HTML stays escaped; remote images and embedded network requests are blocked. HTTP(S) links open in the system browser.
- View draft token estimates and monthly totals across this IntelliJ profile. Backend usage is preferred; otherwise UTF-8 byte estimates plus message overhead are used. Months use local time. These totals are separate from VS Code totals and Azure billing.
- Review `azure-files` proposals in native IntelliJ diff dialogs. **Apply** creates or replaces text files through undoable IDE write commands. Save the editor to persist the contents. Changed targets must be reviewed again. Traversal, protected directories, reserved names, and symlinks escaping the chosen root are rejected. Proposals cannot delete files or run commands. The optional proposal formatting instruction is off by default; enable it in **Connection**.

## Diagnostics and development

Use **Azure Chat: Show API Log** in Find Action to enable logging and show the **Azure Chat API** console. Logs include request and response text, with bearer tokens redacted. Disable logging in **Connection** and clear the console before sharing. HTTP is allowed only on loopback; deployed apps require HTTPS. Redirects are rejected.

```powershell
cd intellij
.\gradlew.bat test buildPlugin
.\gradlew.bat runIde
.\gradlew.bat verifyPluginStructure
.\gradlew.bat verifyPlugin
```

The Gradle wrapper pins Gradle 9.6.1. The build downloads the IntelliJ 2024.3.6 SDK and packages shared assets from `../media`; build from this repository rather than copying the `intellij` folder alone. Protocol tests use a local mock HTTP server and cover history contracts, fragmented UTF-8 streaming, cancellation, redaction, redirect rejection, usage counts, temporary skills, and proposal path validation. They do not connect to Azure.

Verified locally: plugin ZIP creation, descriptor validation, and binary compatibility with IntelliJ IDEA 2024.3.6 (build 243.26574.91). The Java suite passed 30 tests; the symlink test was skipped because this Windows host requires permission to create symlinks. All 30 existing VS Code tests also passed. The verifier reports only the platform's documented experimental project-trust API. Other targeted IDE versions and the interactive flow have not been tested.

For a manual smoke test, open a trusted project in `runIde`, configure a test backend, reopen history, send a follow-up and verify it persisted, pin an unsaved editor file, attach a selection, select and edit skills, cancel a generation, retry a failed history save, and review a new-file and replacement proposal. Also verify clipboard buttons, collapsed skill picker restoration, and the API console. The backend and interactive IDE flow require this manual check.

The plugin targets builds 243–261. IntelliJ 2026.2 moves JCEF behind an explicit module dependency; support for that platform needs a separate compatibility update and verification.
