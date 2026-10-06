package com.azurehistorychat;

import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.components.*;
import org.jetbrains.annotations.NotNull;
import java.util.*;

@State(name = "AzureHistoryChat", storages = @Storage("azure-history-chat.xml"))
public final class ChatSettings implements PersistentStateComponent<ChatSettings.Data> {
    public static final class Month {
        public long input, output, total, requests, estimatedRequests;
    }
    public static final class Data {
        public String baseUrl = "";
        public String historyReadMethod = "GET";
        public int maxAttachmentBytes = 200000;
        public boolean logApiCalls;
        public boolean fileProposalInstructions;
        public Map<String, Month> months = new TreeMap<>();
    }
    private volatile Data state = new Data();
    public static ChatSettings getInstance() { return ApplicationManager.getApplication().getService(ChatSettings.class); }
    @Override public @NotNull Data getState() { return state; }
    @Override public void loadState(@NotNull Data value) { state = value; }
    public synchronized void record(com.google.gson.JsonArray input, com.google.gson.JsonObject output, Protocol.Usage usage) {
        String month = java.time.YearMonth.now().toString();
        Month previous = state.months.computeIfAbsent(month, ignored -> new Month());
        previous.input += usage == null ? Protocol.contextTokens(input) : usage.prompt();
        com.google.gson.JsonArray answer = new com.google.gson.JsonArray(); answer.add(output);
        long completion = usage == null ? Protocol.contextTokens(answer) : usage.completion();
        previous.output += completion;
        previous.total += usage == null ? Protocol.contextTokens(input) + completion : usage.total();
        previous.requests++;
        if (usage == null) previous.estimatedRequests++;
    }
    public synchronized com.google.gson.JsonElement months() { return Protocol.JSON.toJsonTree(state.months); }
}
