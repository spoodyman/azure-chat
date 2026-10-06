# Azure History Chat for IntelliJ IDEA

The IntelliJ counterpart of the VS Code extension in this repository. It uses the same bundled chat UI and the same Azure history API. Requires IntelliJ IDEA 2024.3–2026.2, Community or Ultimate, running the bundled JetBrains Runtime with JCEF. IntelliJ IDEA 2020.1 is not supported.

## Install and connect

1. Download the [prebuilt plugin ZIP](dist/azure-history-chat-intellij-0.1.12.zip) from this repository. To build from source, follow the [local IntelliJ SDK setup](#diagnostics-and-development) below.
2. In IntelliJ, open **Settings → Plugins → ⚙ → Install Plugin from Disk** and choose the downloaded ZIP (or `target/azure-history-chat-intellij-0.1.12.zip` for a local build), then restart when prompted.
3. Open **View → Tool Windows → Azure Chat** and click **Connection**.
4. Enter the deployed Microsoft Azure OpenAI Chat sample application URL and a user bearer token accepted by its authentication layer. This is the application URL, not the Azure OpenAI resource endpoint. Tokens are stored in IntelliJ Password Safe, separately for each application URL, and are never passed to the embedded UI. Leave the token field blank to retain the token for that URL.
5. Select **POST** history reads for the Microsoft sample's `POST /history/read` endpoint, or **GET** for backends exposing `/history/read/{id}`.

Your deployed backend must authenticate the bearer token as a user and have Cosmos DB history configured. The plugin uses the backend's configured model and does not select a deployment. Backend configuration and authentication requirements are the same as [the VS Code extension](../README.md).

## Features

- Create, list, reopen, refresh, and delete chats, with confirmation before deletion.
- Stream JSON, NDJSON, SSE, or adjacent JSON replies. **Stop** cancels the request. After interrupted or failed generations, refresh and reopen history before sending again, since the backend may have stored the user message.
- Save complete conversations with backend IDs and metadata. **Retry saving reply** reuses the same chat message, attachments, and assistant ID, excluding generation instructions. Switching chats and connections is blocked while a reply needs saving. Closing the project discards unsaved pending replies.
- **Pin current file** includes the latest editor text, including unsaved changes, on every request until removed. **Attach selection** is also available in the editor context menu and Find Action; selections include file names and line ranges and are consumed after sending. Click an attachment to remove it.
- Choose multiple Markdown or JSON skills from the project's root `skills/` folder and any additional external content roots. Nested folders, search, live editor changes, and creating skills are supported. Skills and code response instructions enter only the generation prompt, without synthetic system messages; history updates and save retries keep your chat message and attachments. Instructions from previously saved enriched user prompts are also removed from updates. The backend may save the enriched prompt during generation; replacing that stored prompt depends on the backend's update implementation. Removing a selection excludes it from future generation prompts.
- Skills and attachments share the configurable 200 KB default byte limit. Files, skills, and file proposals require a trusted local project.
- File-specific code is grouped in collapsed accordions labelled with project-relative paths and `+`/`−` line counts; unnamed examples use separate **code** accordions. Expand to scroll, copy code, or **Open in editor** for a larger read-only code tab. Expanded states and scroll positions survive updates. Both IDEs share this UI and the response format described in [the VS Code documentation](../README.md#create-or-replace-files). Raw HTML stays escaped; remote images and embedded network requests are blocked. HTTP(S) links open in the system browser.
- Every generation includes a temporary instruction requesting known file paths and distinguishing complete replacements from snippets. It never enters history updates. Full replacements compare against attached full-file snapshots; unified diffs count hunk changes. Counts remain `+? −?` when no reliable comparison exists, including selections and incomplete responses. The response-format instruction is included in estimated request overhead.
- View draft token estimates and monthly totals across this IntelliJ profile. Backend usage is preferred; otherwise UTF-8 byte estimates plus message overhead are used. Months use local time. These totals are separate from VS Code totals and Azure billing.
- Review `azure-files` proposals in native IntelliJ diff dialogs. **Apply** creates or replaces text files through undoable IDE write commands. Save the editor to persist the contents. Changed targets must be reviewed again. Traversal, protected directories, reserved names, and symlinks escaping the chosen root are rejected. Proposals cannot delete files or run commands. The optional proposal formatting instruction is off by default; enable it in **Connection**.

## Diagnostics and development

Use **Azure Chat: Show API Log** in Find Action to enable logging and show the **Azure Chat API** console. Logs include request and response text, with bearer tokens redacted. Disable logging in **Connection** and clear the console before sharing. HTTP is allowed only on loopback; deployed apps require HTTPS. Redirects are rejected.

```powershell
cd intellij
$intellijHome = 'C:\Program Files\JetBrains\IntelliJ IDEA 2026.2.3'
$env:JAVA_HOME = Join-Path $intellijHome 'jbr'
.\mvnw.cmd "-Didea.home=$intellijHome" clean verify
.\mvnw.cmd "-Didea.home=$intellijHome" test

# Once Maven Central dependencies and the Maven wrapper are cached, build offline:
.\mvnw.cmd -o "-Didea.home=$intellijHome" clean verify

# Check plugin structure and binary compatibility against an installed IDE:
.\mvnw.cmd -Pverify-plugin "-Didea.home=$intellijHome" "-Dplugin.verifier.jar=C:\tools\verifier-cli-1.410-all.jar" verify

# Run a separate development IDE with isolated configuration, caches and plugins:
.\mvnw.cmd -Prun-ide "-Didea.home=$intellijHome" verify
```

The Maven wrapper pins Maven 3.9.16. The build has no JetBrains Maven repositories or downloaded IntelliJ platform dependencies. Set `idea.home` to an installed or extracted IntelliJ IDEA distribution from builds 243–262. Maven reads compilation libraries from its `lib/`, bundled JCEF plugin, and legacy JBR JCEF JAR. These SDK libraries never enter the plugin ZIP. Gson, JUnit, and Maven plugins still come from Maven Central; Maven offline mode (`-o`) works after those dependencies and the wrapper have been cached. The normal build does not download an IDE or contact JetBrains repositories.

When compiling against build 262, run Maven on JDK 25 or newer; the IDE's bundled `jbr` directory supplies a suitable JDK on Windows and Linux. With a 2024.3–2026.1 SDK, JDK 21 or newer is sufficient. The output remains Java 21 bytecode. On macOS, `idea.home` is `IntelliJ IDEA.app/Contents`, and the bundled Java home is typically `Contents/jbr/Contents/Home`. Build from the repository so shared `../media` assets are present. Maven copies those assets, filters the descriptor, runs JUnit 5, and creates the plugin ZIP. IDEs importing the POM may need the local IntelliJ SDK libraries configured separately for editor code analysis; the Maven command above supplies the compilation classpath directly.

`clean verify` runs tests and builds `target/azure-history-chat-intellij-0.1.12.zip`. The optional `verify-plugin` profile requires a local Plugin Verifier JAR supplied through `plugin.verifier.jar`; it does not resolve the verifier from a JetBrains Maven repository. Reports are saved under `target/plugin-verifier`. The verifier itself may access JetBrains Marketplace to resolve plugin dependencies; it is separate from the normal build. Compatibility failures, invalid descriptors, internal API uses, and invalid override-only API uses fail verification. Experimental project-trust API reports remain informational. The `run-ide` profile stages the plugin under `target/sandbox/plugins`, then launches `idea.home` with separate settings, caches, and logs. It does not modify the installed IDE's normal profile. Override `-Didea.executable` if the installation uses a different launcher.

Protocol tests use a local mock HTTP server and cover history contracts, fragmented UTF-8 streaming, cancellation, redaction, redirect rejection, usage counts, skill prompts, and proposal path validation. They do not connect to Azure. The Maven build does not need IntelliJ's test bootstrap or a separate JUnit 4 dependency.

The browser page is served from memory at a fixed virtual `file://` address. JCEF rewrites HTTP addresses passed to `loadHTML`, which previously caused the plugin's navigation guard to reject its own page and display an empty panel. The regression test checks URL preservation against the selected SDK's actual JCEF implementation. Version 0.1.12 was also checked in a running `IU-262.10968.63` session: Connection controls, the message box, JavaScript handlers, and the code renderer loaded successfully.

Verified locally: plugin ZIP creation, descriptor validation, and binary compatibility with IntelliJ IDEA 2026.2.3 (`IU-262.10968.63`) and IntelliJ IDEA 2024.3.6 (`IC-243.26574.91`). Java tests cover transient response-format instructions in addition to the backend protocol. The symlink test requires permission to create symlinks on Windows. The shared JavaScript suite covers accordion grouping, line counts, streaming, and larger editor previews; `node test/ui-preview.js` from the repository root generates a local browser fixture with checks for expansion/scroll restoration and code preview actions. On build 262, the verifier reports four deprecated API usages and two experimental project-trust API usages, with no compatibility errors or plugin configuration defects. Other targeted IDE versions and the full interactive IDE flow have not been tested.

For a manual smoke test, launch the `run-ide` profile, open a trusted project, configure a test backend, reopen history, send a follow-up and verify it persisted, pin an unsaved editor file, attach a selection, select and edit skills, cancel a generation, retry a failed history save, and review a new-file and replacement proposal. Also verify clipboard buttons, collapsed skill picker restoration, and the API console. The backend and interactive IDE flow require this manual check.

The plugin targets builds 243–262, including IntelliJ IDEA 2026.2.3 (`IU-262.10968.63`). It declares the bundled `com.intellij.modules.jcef` dependency using an optional descriptor: older supported IDEs provide JCEF in core, while build 262 loads it from the bundled Web Browser plugin. Compilation uses the local SDK selected with `idea.home` and emits Java 21 bytecode; run build 262 using its bundled JetBrains Runtime 25. See [JetBrains' 2026.2 API changes](https://plugins.jetbrains.com/docs/intellij/api-changes-list-2026.html#2026-2).
