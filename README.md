# Azure History Chat for VS Code

A VS Code sidebar that talks to a deployed [Microsoft Azure OpenAI Chat sample](https://github.com/microsoft/sample-app-aoai-chatGPT) with Cosmos DB chat history.

An [IntelliJ IDEA version](intellij/README.md) is also available in `intellij/`, sharing the chat UI and backend contract. Install the [prebuilt plugin ZIP](intellij/dist/azure-history-chat-intellij-0.1.14.zip), or build with `.\mvnw.cmd "-Didea.home=C:\path\to\IntelliJ IDEA" clean verify` from the `intellij` directory. The build uses your local IntelliJ installation instead of JetBrains Maven repositories; see the [build setup](intellij/README.md#diagnostics-and-development) for Java requirements. It targets IntelliJ IDEA 2024.3–2026.2.

## Install and connect

1. Install the generated `azure-history-chat-0.1.12.vsix` using **Extensions → … → Install from VSIX**.
2. Open **Azure Chat** in the activity bar and click **Connection**.
3. Enter your sample app's base URL, for example `https://your-chat-app.azurewebsites.net`. This is the chat application URL, not the Azure OpenAI resource URL.
4. Paste a user bearer token accepted by that app's authentication layer. The token is stored in VS Code SecretStorage and never sent to the webview. Repeat Connection to replace an expired token; leave the token field blank to retain it.

The backend must authenticate the bearer token as your user and have Cosmos DB history configured. The sample reads user identity from its authentication layer, so merely passing an Azure OpenAI resource token to an unconfigured sample does not establish per-user history. Configure the token audience and authentication on the deployed app or its gateway. Do not add client-supplied identity headers as a substitute for authentication.

The extension does not select a model. Your Azure backend must be configured to use the deployment serving `gpt-5.4-mini-2026-03-17` and parameters supported by that model, including the sample's separate title-generation call.

## Use

- Select an existing chat, or choose **New chat**. New chats are created when the first message is sent.
- **Refresh** reloads chat history.
- **Pin current file** includes the open editor file's name and complete contents, including unsaved changes. Successful history updates clear all attachments, pinned files, and selected skills; failed saves retain them for retry.
- Select text in an editor and use **Azure Chat: Attach Selection** from the command palette or editor context menu. The name includes the source path and line range.
- Click an attachment to remove it before sending. The combined default limit is 200 KB, adjustable in `azureChat.maxAttachmentBytes`. The server's context limit still applies.
- Send with the button or Enter. Shift+Enter inserts a new line. Streaming and ordinary JSON replies are supported. **Stop** cancels the client request; backend generation may already have saved the user message.
- Select a chat from history and use **Delete chat** to remove it and its messages after confirmation. Save any pending reply first.
- Code appears in collapsed accordions. File-specific blocks are grouped under their relative path, with green `+` and red `−` line counts; unnamed examples each have a **code** accordion. Expanded code uses the page's vertical scrolling. **Open in editor** opens the actual project file when it exists, otherwise a read-only preview labelled with the proposed path. Expanded state and horizontal scroll positions survive updates. **Copy reply** copies the original Markdown.
- All attachments travel as text within JSON. There are no uploads, image inputs, or native model tools. Attached text becomes part of server chat history.

## Workspace skills

Store reusable instructions in `.md` or `.json` files inside a `skills` folder at the workspace root. Subfolders can be nested freely, for example:

```text
skills/
  Test/
    write-component-unit-test.md
    write-service-unit-test.md
    write-cypress-e2e-test.md
  Component/
    write-component.md
```

Use **New skill** above the message box to create a file such as `Test/write-component-unit-test.md`; parent folders are created automatically and the file opens for editing. Markdown can contain ordinary instructions. JSON has no required schema and is sent as text. Existing files are never overwritten by this action.

Click **Skills (selected/total)** to expand or collapse the picker; its expanded state is remembered. Search by file or folder name and check multiple skills to include them as context. The heading counts all available skills, even while filtering. Selected skills remain visible when filtering; click a selected skill to remove it. Files appear automatically when created, changed or deleted. In a workspace with multiple roots, names include the workspace folder. Skills require a trusted workspace.

Each generation reads the latest selected contents, including unsaved editor changes. Skills and code response instructions are included only in the generation prompt, with the normal user message ID and date; no synthetic system messages are added. History updates and save retries contain your chat message and attached files, excluding selected skills and response instructions. History reads also remove injected instructions and skills from stored user prompts before displaying them or reusing them in follow-up generation. Assistant and tool messages, attachments, and message metadata are preserved. This cleanup does not change stored database content; API response logs show the original backend response. The backend may save the enriched user prompt during generation; whether update replaces that stored prompt depends on the backend. Removing a selection excludes it from future generation prompts. Selected skills and attachments share the `azureChat.maxAttachmentBytes` limit.

## Token usage

Selected skills are included in draft and next request estimates, and in estimated monthly input usage.

The estimated next request token count stays visible beside **Message** and updates as you type. Expand **Token usage** above the message box to see separate estimates for chat context, selected skills, user chatbox text, and pinned files or attached selections. Message overhead and optional file proposal instructions appear separately so the breakdown adds up to the combined next request context. Skills and attachments include their context formatting. Counts update while typing, attaching text, editing selected skills or pinned files, opening chats and receiving replies. These use UTF-8 bytes divided by four plus message overhead, rather than a model tokenizer; backend system prompts, retrieval and context truncation are unknown.

Choose a month to see input, output and total tokens across requests made through this extension in this VS Code profile. Backend `usage` counts are used when returned; otherwise counts are estimated and the number of estimated requests is shown. Each follow-up counts its full input context again. Totals persist across restarts and chat deletion, and saving retries do not count again. Months use local calendar time. Tracking starts with this feature; older chats, other clients, backend title generation and cancelled or failed generations are not included. This is not an Azure billing report.

## Create or replace files

Each generation includes a temporary response-format instruction asking the model to identify known project-relative file paths. This instruction is counted in request estimates and monthly input usage, but is excluded from history updates and save retries. Attached files include explicit paths and distinguish full files from selections. The model is instructed to keep unknown-file code unnamed and never invent paths.

Full-file proposals use `azure-files` JSON, as below. Ordinary snippets can use a fence such as `typescript file="src/example.ts"`; `complete=true` marks a full replacement and `new=true` a new file. Unified `diff` fences can contain one or multiple files. Complete replacements are compared with the full file attached to the preceding user message; diffs count added and removed hunk lines. New files can use `"newFile":true` and show `+N −0`. When originals are missing, a selection is attached, or the response is only a snippet, counts show `+? −?` rather than guessing. Very expensive comparisons also leave counts unknown. File paths in responses are model-provided labels; applying a file still requires review.

Enable `azureChat.fileProposalInstructions` to additionally append the legacy full-file formatting instruction to the user message; this setting remains off by default. The proposal format is:

````text
```azure-files
{"files":[{"path":"src/example.ts","content":"export const answer = 42;\n"}]}
```
````

Named accordions offer **Apply patch** for unified diffs, **Apply file** for complete replacements, and **Create file** for named snippets whose file does not exist. Unnamed **code** blocks offer no file creation. **Review file changes** also reviews full-file JSON proposals. Each change opens in a native diff, followed by an Apply prompt. Patches must match the current file's context exactly; named snippets cannot overwrite existing files. Applying uses undoable workspace edits; save the resulting editor to persist its contents. Proposals cannot delete files or execute commands. They require a trusted local workspace; absolute paths, traversal, protected directories and symbolic links outside the root are rejected.

This is a text protocol: the model may need to be asked again if it omits the block or provides invalid JSON. Assistant replies render Markdown including headings, lists, links, tables and fenced code. Raw HTML is displayed as text, and remote images are not loaded. User messages display as plain text.

## History behavior and troubleshooting

Set `azureChat.historyReadMethod` to `POST` for the Microsoft sample route (`POST /history/read` with a `conversation_id` body), or keep `GET` for `/history/read/{id}`. Both a message array and an object containing `messages` are accepted. A 404 can mean the route is missing or the conversation does not exist or is inaccessible; inspect the logged response body to distinguish these cases.

The client uses `GET /history/list?offset=…`, `GET /history/read/{id}`, `POST /history/generate`, and `POST /history/update`, matching the deployed app contract. Existing chats send `generated: "false"`; new user messages include an ISO `date`. Generation accepts JSON, newline-delimited JSON, SSE, and adjacent streamed JSON objects. Before each follow-up, the extension reloads stored history to preserve backend message IDs, dates, attachments, feedback and prompt fragments. Generation saves the user message; update sends the complete conversation, including the dated assistant response. If saving fails, use **Retry saving reply** before switching conversations. Retries reuse the assistant response ID. Closing VS Code discards an unsaved pending reply.

After a cancelled or failed generation, refresh and reopen the chat, or start a new chat before sending again. A failed request may already have stored the user message on the backend. If a new conversation failed before returning its ID, look for it in refreshed history. API logging is off by default. Run **Azure Chat: Show API Log** to enable logging and open the **Azure Chat API** Output channel, then reproduce the request. Entries show timestamps, request IDs, URL, HTTP method, JSON body, response status, content type, and response body chunks (including error bodies). Authorization headers are excluded and the configured bearer token is redacted. Logs include chat and attached file contents. Disable logging with `azureChat.logApiCalls` when finished; clear the Output channel before sharing logs.

HTTP is allowed only on loopback for development; deployed connections require HTTPS. Redirects are rejected to avoid forwarding credentials to another host. HTTP 401/403 usually indicates an expired token, wrong audience, or insufficient app access. Other failures require checking the sample backend and Cosmos configuration.

## Development

Requires Node.js 22+ and VS Code 1.96+.

```powershell
npm.cmd install
npm.cmd test
npm.cmd run package
```

Press F5 to launch the Extension Development Host. Tests exercise the API contract against a local mock server, fragmented streaming, errors, cancellation and proposal path validation. They do not connect to Azure. To verify the live app: list existing history, reopen a chat, send a reply, refresh and confirm it persisted, attach two files and a selection, then review and apply one new-file and one replacement proposal.
