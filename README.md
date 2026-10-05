# Azure History Chat for VS Code

A VS Code sidebar that talks to a deployed [Microsoft Azure OpenAI Chat sample](https://github.com/microsoft/sample-app-aoai-chatGPT) with Cosmos DB chat history.

## Install and connect

1. Install the generated `azure-history-chat-0.1.5.vsix` using **Extensions → … → Install from VSIX**.
2. Open **Azure Chat** in the activity bar and click **Connection**.
3. Enter your sample app's base URL, for example `https://your-chat-app.azurewebsites.net`. This is the chat application URL, not the Azure OpenAI resource URL.
4. Paste a user bearer token accepted by that app's authentication layer. The token is stored in VS Code SecretStorage and never sent to the webview. Repeat Connection to replace an expired token; leave the token field blank to retain it.

The backend must authenticate the bearer token as your user and have Cosmos DB history configured. The sample reads user identity from its authentication layer, so merely passing an Azure OpenAI resource token to an unconfigured sample does not establish per-user history. Configure the token audience and authentication on the deployed app or its gateway. Do not add client-supplied identity headers as a substitute for authentication.

The extension does not select a model. Your Azure backend must be configured to use the deployment serving `gpt-5.4-mini-2026-03-17` and parameters supported by that model, including the sample's separate title-generation call.

## Use

- Select an existing chat, or choose **New chat**. New chats are created when the first message is sent.
- **Refresh** reloads chat history.
- **Pin current file** pins the open editor file and includes its name and complete contents with each message until removed. Pinned files use the latest editor contents, including unsaved changes.
- Select text in an editor and use **Azure Chat: Attach Selection** from the command palette or editor context menu. The name includes the source path and line range.
- Click an attachment to remove it before sending. The combined default limit is 200 KB, adjustable in `azureChat.maxAttachmentBytes`. The server's context limit still applies.
- Send with the button or Enter. Shift+Enter inserts a new line. Streaming and ordinary JSON replies are supported. **Stop** cancels the client request; backend generation may already have saved the user message.
- Select a chat from history and use **Delete chat** to remove it and its messages after confirmation. Save any pending reply first.
- **Copy reply** copies the original Markdown. Each code block has **Copy code** and syntax highlighting for common languages; unknown languages appear as plain text.
- All attachments travel as text within JSON. There are no uploads, image inputs, or native model tools. Attached text becomes part of server chat history.

## Token usage

The estimated next request token count stays visible beside **Message** and updates as you type. Expand **Token usage** above the message box to see estimated chat context, draft tokens including attachments and optional file proposal instructions, and the combined next request context. Counts update while typing, attaching text, editing pinned files, opening chats and receiving replies. These use UTF-8 bytes divided by four plus message overhead, rather than a model tokenizer; backend system prompts, retrieval and context truncation are unknown.

Choose a month to see input, output and total tokens across requests made through this extension in this VS Code profile. Backend `usage` counts are used when returned; otherwise counts are estimated and the number of estimated requests is shown. Each follow-up counts its full input context again. Totals persist across restarts and chat deletion, and saving retries do not count again. Months use local calendar time. Tracking starts with this feature; older chats, other clients, backend title generation and cancelled or failed generations are not included. This is not an Azure billing report.

## Create or replace files

Ask the assistant to create or update a file. Enable `azureChat.fileProposalInstructions` to append the formatting instruction when requesting file proposals, or specify this format in your own prompt. This setting is off by default so ordinary prompts contain only your text and attachments. The proposal format is:

````text
```azure-files
{"files":[{"path":"src/example.ts","content":"export const answer = 42;\n"}]}
```
````

Click **Review file changes** on the reply. Choose a workspace folder when several are open. Each file opens in a VS Code diff, followed by an Apply prompt. Applying uses VS Code workspace edits; save the resulting editor to persist its contents. You can undo edits normally. Proposals cannot delete files or execute commands. They require a trusted local workspace; absolute paths, traversal, protected directories and symbolic links outside the root are rejected. A malformed proposal produces an error and does not apply.

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
