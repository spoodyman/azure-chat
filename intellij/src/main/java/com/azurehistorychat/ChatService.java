package com.azurehistorychat;

import com.google.gson.*;
import com.intellij.credentialStore.*;
import com.intellij.ide.BrowserUtil;
import com.intellij.ide.passwordSafe.PasswordSafe;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.editor.event.*;
import com.intellij.openapi.editor.EditorFactory;
import com.intellij.openapi.ide.CopyPasteManager;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.ui.Messages;
import com.intellij.openapi.vfs.*;
import com.intellij.openapi.vfs.newvfs.BulkFileListener;
import com.intellij.openapi.vfs.newvfs.events.VFileEvent;
import com.intellij.openapi.wm.*;
import com.intellij.execution.ui.ConsoleView;
import com.intellij.execution.ui.ConsoleViewContentType;
import com.intellij.execution.filters.TextConsoleBuilderFactory;
import com.intellij.ui.content.ContentFactory;
import com.intellij.util.messages.MessageBusConnection;
import java.awt.datatransfer.StringSelection;
import java.nio.file.Path;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import static com.azurehistorychat.Protocol.*;

/** A single worker owns conversation state; HTTP and Password Safe never block the UI. */
public final class ChatService implements Disposable {
    private final Project project;
    private final Workspace workspace;
    private final ExecutorService worker = Executors.newSingleThreadExecutor(runnable -> { Thread thread = new Thread(runnable, "Azure Chat"); thread.setDaemon(true); return thread; });
    private final AtomicBoolean refreshQueued = new AtomicBoolean();
    private volatile Consumer<JsonObject> sink;
    private volatile boolean operation, generating, disposed;
    private volatile AzureClient.Cancellation cancellation;
    private JsonArray messages = new JsonArray(), conversations = new JsonArray(), pendingSave;
    private String pendingConversationId, pendingDraft;
    private String conversationId, status = "", draft = "";
    private boolean needsReopen;
    private final List<Attachment> attachments = new ArrayList<>();
    private List<Workspace.Skill> skills = new ArrayList<>();
    private Set<String> selected = new LinkedHashSet<>();
    private ConsoleView apiConsole;
    private record Attachment(String id, String name, String content, Path pinned) {}
    @FunctionalInterface private interface Task { void run() throws Exception; }

    public ChatService(Project project) {
        this.project = project; workspace = new Workspace(project);
        EditorFactory.getInstance().getEventMulticaster().addDocumentListener(new DocumentListener() {
            @Override public void documentChanged(DocumentEvent event) { refreshContext(); }
        }, this);
        MessageBusConnection connection = project.getMessageBus().connect(this);
        connection.subscribe(VirtualFileManager.VFS_CHANGES, new BulkFileListener() {
            @Override public void after(List<? extends VFileEvent> events) { if (events.stream().anyMatch(event -> event.getPath().replace('\\', '/').contains("/skills/"))) refreshContext(); }
        });
    }
    public static ChatService getInstance(Project project) { return project.getService(ChatService.class); }
    void bind(Consumer<JsonObject> view) { sink = view; }
    void unbind(Consumer<JsonObject> view) { if (sink == view) sink = null; }
    private void emit(JsonObject event) { Consumer<JsonObject> current = sink; if (current != null && !disposed) current.accept(event); }
    private void submit(Task task) {
        if (disposed) return;
        worker.execute(() -> { if (disposed) return; try { task.run(); } catch (Exception error) { status = errorMessage(error); } finally { render(); } });
    }
    private static String errorMessage(Throwable error) {
        while ((error instanceof ExecutionException || error instanceof CompletionException) && error.getCause() != null) error = error.getCause();
        return error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage();
    }
    public void dispatch(JsonObject event) {
        String type = string(event, "type");
        if (type.equals("stop")) { AzureClient.Cancellation current = cancellation; if (current != null) current.cancel(); return; }
        if (type.equals("open-code")) {
            ApplicationManager.getApplication().invokeLater(() -> {
                if (project.isDisposed()) return;
                try { workspace.openCode(string(event,"text"),string(event,"path"),string(event,"language")); }
                catch (Exception error) { Messages.showErrorDialog(project,errorMessage(error),"Azure Chat Code Preview"); }
            }); return;
        }
        if (type.equals("copy")) {
            ApplicationManager.getApplication().invokeLater(() -> {
                JsonObject response = object("type", "copied", "id", event.get("id"));
                try { CopyPasteManager.getInstance().setContents(new StringSelection(string(event, "text"))); }
                catch (RuntimeException error) { response.addProperty("error", true); }
                emit(response);
            }); return;
        }
        if (type.equals("external")) {
            String link = string(event, "url");
            try { java.net.URI uri = java.net.URI.create(link); if (List.of("http", "https").contains(uri.getScheme())) BrowserUtil.browse(link); } catch (RuntimeException ignored) {}
            return;
        }
        if (type.equals("draft")) { submit(() -> draft = string(event, "text")); return; }
        if (operation || disposed) return;
        submit(() -> {
            if (operation) return;
            operation = true; render();
            try {
                switch (type) {
                    case "ready" -> { refreshSkills(); if (!settings().baseUrl.isEmpty() && !token(settings().baseUrl).isEmpty()) list(); }
                    case "configure" -> configure();
                    case "new" -> { requireSaved(); conversationId = null; messages = new JsonArray(); needsReopen = false; status = ""; }
                    case "refresh" -> { refreshSkills(); list(); }
                    case "open" -> { requireSaved(); try (AzureClient client = client()) { JsonArray history = client.read(string(event, "id")); messages = history; conversationId = string(event, "id"); needsReopen = false; status = ""; } }
                    case "delete" -> delete();
                    case "pin" -> attach(false);
                    case "selection" -> attach(true);
                    case "remove" -> attachments.removeIf(value -> value.id().equals(string(event, "id")));
                    case "create-skill" -> { workspace.createSkill(); refreshSkills(); status = "Skill created. Edit its instructions."; }
                    case "select-skills" -> {
                        Set<String> ids = new LinkedHashSet<>(); for (JsonElement id : event.getAsJsonArray("ids")) ids.add(id.getAsString());
                        workspace.skillContents(skills, ids, settings().maxAttachmentBytes); selected = ids;
                    }
                    case "send" -> send(string(event, "text"));
                    case "retry" -> save();
                    case "changes" -> {
                        int index = event.get("index").getAsInt();
                        if (index >= 0 && index < messages.size() && string(messages.get(index).getAsJsonObject(), "role").equals("assistant")) { workspace.review(string(messages.get(index).getAsJsonObject(), "content")); status = "File changes reviewed. Save applied editors to write their contents to disk."; }
                    }
                    case "apply-code" -> { workspace.applyCode(string(event,"text"),string(event,"path"),string(event,"kind")); status="File change reviewed. Save applied editors to write it to disk."; }
                    case "show-log" -> showLog();
                    default -> { }
                }
            } finally { operation = false; }
        });
    }
    public void attachSelection() { dispatch(object("type", "selection")); show(); }
    public void configureConnection() { dispatch(object("type", "configure")); show(); }
    public void showApiLog() { dispatch(object("type", "show-log")); }
    private void show() { ApplicationManager.getApplication().invokeLater(() -> { if (!project.isDisposed()) { ToolWindow window = ToolWindowManager.getInstance(project).getToolWindow("Azure Chat"); if (window != null) window.show(); } }); }
    private ChatSettings.Data settings() { return ChatSettings.getInstance().getState(); }
    private CredentialAttributes credentials(String url) { return new CredentialAttributes(CredentialAttributesKt.generateServiceName("Azure History Chat", url)); }
    private String token(String url) { String value = PasswordSafe.getInstance().getPassword(credentials(url)); return value == null ? "" : value; }
    private AzureClient client() {
        ChatSettings.Data settings = settings(); String baseUrl = settings.baseUrl;
        String token = token(baseUrl);
        if (baseUrl.isEmpty() || token.isEmpty()) throw new IllegalStateException("Configure the Azure sample URL and bearer token first.");
        return new AzureClient(baseUrl, token, settings.historyReadMethod, settings.logApiCalls ? this::log : null);
    }
    private void requireSaved() { if (pendingSave != null) throw new IllegalStateException("Save the pending reply before changing chats or connections."); }
    private void configure() throws Exception {
        requireSaved();
        record Connection(String url, String token, String method, int limit, boolean proposals, boolean logging) {}
        Connection value = Workspace.ui(() -> {
            ConnectionDialog dialog = new ConnectionDialog(project, settings());
            return dialog.showAndGet() ? new Connection(dialog.url(), dialog.token(), dialog.readMethod(), dialog.limit(), dialog.proposals(), dialog.logging()) : null;
        });
        if (value == null) return;
        if (value.token().isEmpty() && token(value.url()).isEmpty()) throw new IllegalStateException("A bearer token is required for this URL.");
        if (!value.token().isEmpty()) PasswordSafe.getInstance().setPassword(credentials(value.url()), value.token());
        ChatSettings.Data state = settings(); state.baseUrl = value.url(); state.historyReadMethod = value.method(); state.maxAttachmentBytes = value.limit(); state.fileProposalInstructions = value.proposals(); state.logApiCalls = value.logging();
        messages = new JsonArray(); conversations = new JsonArray(); conversationId = null; needsReopen = false;
        list();
    }
    private void list() throws Exception {
        try (AzureClient client = client()) {
            JsonElement result = client.json("/history/list?offset=0", null, "GET");
            if (!result.isJsonArray()) throw new IllegalStateException("Unexpected chat history response.");
            conversations = result.getAsJsonArray(); status = conversations.isEmpty() ? "No chats." : "";
        }
    }
    private void delete() throws Exception {
        requireSaved(); if (conversationId == null) return;
        boolean confirmed = Workspace.ui(() -> Messages.showYesNoDialog(project, "Delete this chat and all its messages?", "Delete Azure Chat", "Delete", "Cancel", Messages.getWarningIcon()) == Messages.YES);
        if (!confirmed) return;
        try (AzureClient client = client()) { client.json("/history/delete", object("conversation_id", conversationId), "DELETE"); }
        JsonArray remaining = new JsonArray(); for (JsonElement item : conversations) if (!string(item.getAsJsonObject(), "id").equals(conversationId)) remaining.add(item);
        conversations = remaining; conversationId = null; messages = new JsonArray(); needsReopen = false; status = "Chat deleted.";
    }
    private void attach(boolean selection) throws Exception {
        Workspace.EditorText editor = workspace.editor(selection);
        Path pinned = selection ? null : Path.of(editor.file().getPath());
        if (pinned != null && attachments.stream().anyMatch(value -> pinned.equals(value.pinned()))) return;
        long used = attachments.stream().mapToLong(value -> bytes(value.content())).sum();
        Workspace.validateText(editor.content(), settings().maxAttachmentBytes - used);
        attachments.add(new Attachment(UUID.randomUUID().toString(), editor.name(), editor.content(), pinned));
    }
    private void refreshSkills() throws Exception {
        skills = workspace.discover(); selected.removeIf(id -> skills.stream().noneMatch(value -> value.id().equals(id)));
    }
    private void refreshContext() {
        if (disposed || !refreshQueued.compareAndSet(false, true)) return;
        submit(() -> { refreshQueued.set(false); refreshSkills(); });
    }
    private JsonArray attachmentContents() throws Exception {
        if (!attachments.isEmpty()) workspace.requireTrust();
        JsonArray result = new JsonArray(); long used = 0;
        for (Attachment item : attachments) {
            String content = item.pinned() == null ? item.content() : workspace.text(item.pinned(), settings().maxAttachmentBytes - used);
            Workspace.validateText(content, settings().maxAttachmentBytes - used); used += bytes(content);
            result.add(object("name", item.name(), "content", content, "path", item.name().replaceFirst(":\\d+-\\d+$", ""), "kind", item.pinned() == null ? "selection" : "file"));
        }
        return result;
    }
    private String attachmentText(JsonArray attached) { return attached.isEmpty() ? "" : "\n\nAttached text (JSON):\n" + JSON.toJson(attached); }
    private String compose(String text, JsonArray attached) { return text + (settings().fileProposalInstructions ? PROPOSAL_INSTRUCTION : "") + attachmentText(attached); }
    private void send(String text) throws Exception {
        requireSaved();
        if (needsReopen) throw new IllegalStateException("Reopen the chat from history or start a new chat before sending.");
        if (text.isBlank()) return;
        draft = text;
        refreshSkills(); JsonArray attached = attachmentContents();
        long used = 0; for (JsonElement item : attached) used += bytes(string(item.getAsJsonObject(), "content"));
        JsonArray selectedSkills = workspace.skillContents(skills, selected, settings().maxAttachmentBytes - used);
        try (AzureClient client = client()) {
            if (conversationId != null) messages = client.read(conversationId);
            JsonArray previousMessages = messages.deepCopy(); String previousConversationId = conversationId;
            messages.add(message("user", compose(text, attached)));
            JsonArray input = withCodeContext(withSkills(messages, selectedSkills),true);
            generating = true; cancellation = new AzureClient.Cancellation(); status = "Generating…";
            JsonObject placeholder = message("assistant", ""); messages.add(placeholder); render();
            long[] lastRender = {0};
            try {
                AzureClient.Generation response = client.generate(input, conversationId, cancellation, (content, metadata) -> {
                    placeholder.addProperty("content", content);
                    if (!string(metadata, "conversation_id").isEmpty()) conversationId = string(metadata, "conversation_id");
                    if (System.nanoTime() - lastRender[0] > 50_000_000) { lastRender[0] = System.nanoTime(); render(); }
                });
                messages.remove(messages.size() - 1); for (JsonElement tool : response.tools()) messages.add(tool); messages.add(response.message());
                ChatSettings.getInstance().record(input, response.message(), response.usage());
                if (conversationId == null) throw new IllegalStateException("Reply received without a conversation ID; cannot save history.");
                pendingSave = messages.deepCopy(); pendingConversationId = conversationId; pendingDraft = text; save();
                try { list(); status = "Reply saved to chat history."; } catch (Exception error) { status = "Reply saved. History refresh failed; use Refresh."; }
            } catch (Exception error) {
                messages = previousMessages; conversationId = previousConversationId;
                needsReopen = pendingSave == null && previousConversationId != null;
                String detail = cancellation.isCancelled() && pendingSave == null ? "Stopped." : errorMessage(error);
                status = detail + " Your draft is kept. " + (pendingSave != null ? "Use Retry saving reply." : previousConversationId != null ? "Reopen the chat before retrying; Azure may already have saved your message." : "Azure may already have saved your message; check history before retrying.");
            } finally { generating = false; cancellation = null; }
        }
    }
    private void save() throws Exception {
        String savedConversationId = pendingConversationId == null ? conversationId : pendingConversationId;
        if (pendingSave == null || savedConversationId == null) return;
        try (AzureClient client = client()) { client.json("/history/update", object("conversation_id", savedConversationId, "messages", pendingSave), "POST"); }
        messages = pendingSave.deepCopy(); conversationId = savedConversationId;
        if (pendingDraft != null) { if (draft.equals(pendingDraft)) draft = ""; emit(object("type", "sent", "text", pendingDraft)); }
        pendingConversationId = null; pendingDraft = null;
        attachments.clear();selected.clear();
        pendingSave = null; needsReopen = false; status = "Reply saved to chat history.";
    }
    private JsonObject tokenState() throws Exception {
        JsonArray attached = attachmentContents();
        JsonArray selectedSkills = workspace.skillContents(skills, selected, settings().maxAttachmentBytes);
        String content = compose(draft, attached); JsonArray next = messages.deepCopy(); JsonObject user = message("user", content);
        boolean hasDraft = !content.isEmpty() || !selectedSkills.isEmpty(); if (hasDraft) next.add(user);
        long context = contextTokens(messages), request = contextTokens(hasDraft ? withCodeContext(withSkills(next, selectedSkills),true) : next);
        JsonArray single = new JsonArray(); single.add(message("user", ""));
        long skillTokens = contextTokens(withSkills(single, selectedSkills)) - contextTokens(single);
        long chatbox = estimate(draft), pinned = estimate(attachmentText(attached));
        return object("context", context, "chatbox", chatbox, "pinnedFiles", pinned, "skills", skillTokens, "overhead", request - context - chatbox - pinned - skillTokens, "request", request, "month", java.time.YearMonth.now().toString(), "months", ChatSettings.getInstance().months());
    }
    private void render() {
        if (sink == null || disposed) return;
        JsonObject tokens;
        try { tokens = tokenState(); } catch (Exception error) { tokens = object("context", contextTokens(messages), "chatbox", estimate(draft), "pinnedFiles", 0, "skills", 0, "overhead", 0, "request", contextTokens(messages) + estimate(draft), "month", java.time.YearMonth.now().toString(), "months", ChatSettings.getInstance().months()); if (!operation) status = errorMessage(error); }
        JsonArray shown = messages.deepCopy();
        for (JsonElement value : shown) { JsonObject message = value.getAsJsonObject(); if (string(message, "role").equals("user")) message.addProperty("content", displayPrompt(string(message, "content")).replace(PROPOSAL_INSTRUCTION, "")); }
        JsonArray skillList = new JsonArray(); for (Workspace.Skill skill : skills) skillList.add(object("id", skill.id(), "name", skill.name()));
        JsonArray attachmentList = new JsonArray(); for (Attachment item : attachments) attachmentList.add(object("id", item.id(), "name", item.name()));
        emit(object("type", "state", "tokens", tokens, "messages", shown, "conversations", conversations, "conversationId", conversationId, "attachments", attachmentList, "skills", skillList, "selectedSkillIds", selected, "busy", operation, "generating", generating, "status", status, "pendingSave", pendingSave != null, "needsReopen", needsReopen));
    }
    private void ensureConsole() throws Exception {
        Workspace.ui(() -> {
            if (apiConsole == null) {
                apiConsole = TextConsoleBuilderFactory.getInstance().createBuilder(project).getConsole();
                com.intellij.openapi.util.Disposer.register(this, apiConsole);
                ToolWindow window = ToolWindowManager.getInstance(project).getToolWindow("Azure Chat API");
                if (window == null) window = ToolWindowManager.getInstance(project).registerToolWindow("Azure Chat API", builder -> {
                    builder.anchor = ToolWindowAnchor.BOTTOM;
                    builder.canCloseContent = false;
                    return kotlin.Unit.INSTANCE;
                });
                window.getContentManager().addContent(ContentFactory.getInstance().createContent(apiConsole.getComponent(), "", false));
            }
            return null;
        });
    }
    private void showLog() throws Exception {
        settings().logApiCalls = true; ensureConsole(); Workspace.ui(() -> { ToolWindowManager.getInstance(project).getToolWindow("Azure Chat API").show(); return null; });
        status = "API logging enabled. Logs include chat and attached text. Disable logging in Connection when finished.";
    }
    private void log(String line) { try { ensureConsole(); apiConsole.print(line + "\n", ConsoleViewContentType.NORMAL_OUTPUT); } catch (Exception ignored) {} }
    @Override public void dispose() { disposed = true; sink = null; if (cancellation != null) cancellation.cancel(); worker.shutdownNow(); }
}
