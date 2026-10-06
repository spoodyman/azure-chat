package com.azurehistorychat;

import com.google.gson.*;
import java.io.*;
import java.net.*;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.*;
import static com.azurehistorychat.Protocol.*;

public final class AzureClient implements AutoCloseable {
    private final String baseUrl, token, readMethod;
    private final Consumer<String> logger;
    private final HttpClient http = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).connectTimeout(Duration.ofSeconds(30)).build();
    public record Generation(JsonObject message, JsonObject metadata, JsonArray tools, Usage usage) {}
    public static final class Cancellation {
        private volatile boolean cancelled;
        private volatile CompletableFuture<?> request;
        private volatile InputStream body;
        public boolean isCancelled() { return cancelled; }
        public void cancel() {
            cancelled = true;
            if (request != null) request.cancel(true);
            if (body != null) try { body.close(); } catch (IOException ignored) {}
        }
        void check() { if (cancelled) throw new CancellationException("Stopped."); }
    }
    public AzureClient(String baseUrl, String token, String readMethod, Consumer<String> logger) {
        this.baseUrl = validateUrl(baseUrl);
        this.token = token; this.readMethod = readMethod; this.logger = logger;
    }
    public static String validateUrl(String value) {
        URI uri;
        try { uri = URI.create(value.trim()); } catch (IllegalArgumentException error) { throw new IllegalArgumentException("Enter a valid chat application URL."); }
        String host = uri.getHost();
        boolean loopback = List.of("localhost", "127.0.0.1", "[::1]", "::1").contains(host == null ? "" : host.toLowerCase(Locale.ROOT));
        if (host == null || !("https".equalsIgnoreCase(uri.getScheme()) || "http".equalsIgnoreCase(uri.getScheme()) && loopback)) throw new IllegalArgumentException("Use HTTPS, or HTTP on localhost.");
        if (uri.getUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null) throw new IllegalArgumentException("Use a base URL without credentials, query, or fragment.");
        return uri.toString().replaceAll("/+$", "");
    }
    private void log(String id, String entry) {
        if (logger != null) logger.accept("[" + Instant.now() + "] " + id + " " + (token.isEmpty() ? entry : entry.replace(token, "[REDACTED]")));
    }
    private InputStream request(String route, JsonObject body, String method, Cancellation cancel) throws Exception {
        cancel.check();
        String id = UUID.randomUUID().toString();
        if (body != null && body.has("messages")) {
            body = body.deepCopy(); JsonArray messages = body.getAsJsonArray("messages");
            body.add("messages", wireMessages(route.equals("/history/update") ? historyMessages(messages) : messages));
        }
        String text = body == null ? "" : JSON.toJson(body);
        log(id, method + " " + baseUrl + route + "\nRequest body: " + (body == null ? "(none)" : text));
        HttpRequest request = HttpRequest.newBuilder(URI.create(baseUrl + route)).timeout(Duration.ofSeconds(120))
            .header("Authorization", "Bearer " + token).header("Content-Type", "application/json")
            .method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(text)).build();
        CompletableFuture<HttpResponse<InputStream>> future = http.sendAsync(request, HttpResponse.BodyHandlers.ofInputStream());
        cancel.request = future;
        try {
            cancel.check();
            HttpResponse<InputStream> response = future.get(120, TimeUnit.SECONDS);
            cancel.body = response.body(); cancel.check();
            log(id, "Response: " + response.statusCode() + "; Content-Type: " + response.headers().firstValue("content-type").orElse("(none)"));
            InputStream stream = new FilterInputStream(response.body()) {
                @Override public int read(byte[] bytes, int off, int len) throws IOException { cancel.check(); return super.read(bytes, off, len); }
            };
            // All response bodies are consumed through readers, avoiding corrupted UTF-8 log chunks.
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                String error;
                try (stream) { error = new String(stream.readNBytes(1_000_000), StandardCharsets.UTF_8); }
                log(id, "Response body: " + error);
                String detail = "";
                try { JsonObject parsed = JsonParser.parseString(error).getAsJsonObject(); detail = string(parsed, "error"); if (detail.isEmpty()) detail = string(parsed, "message"); } catch (RuntimeException ignored) {}
                if (!token.isEmpty()) detail = detail.replace(token, "[REDACTED]");
                if (detail.length() > 1000) detail = detail.substring(0, 1000);
                throw new IOException("Azure request failed (" + response.statusCode() + ") for " + method + " " + route + ". " + (detail.isEmpty() ? "Check the bearer token, app access, and API log." : detail));
            }
            return stream;
        } catch (Exception error) { future.cancel(true); log(id, "Request failed: " + error.getClass().getSimpleName()); throw error; }
    }
    public JsonElement json(String route, JsonObject body, String method) throws Exception {
        Cancellation cancel = new Cancellation();
        ScheduledExecutorService deadline = Executors.newSingleThreadScheduledExecutor();
        deadline.schedule(cancel::cancel, 120, TimeUnit.SECONDS);
        try (InputStream stream = request(route, body, method, cancel); Reader reader = new InputStreamReader(stream, StandardCharsets.UTF_8)) {
            StringBuilder text = new StringBuilder(); char[] buffer = new char[4096]; int count;
            while ((count = reader.read(buffer)) != -1) { String chunk = new String(buffer, 0, count); text.append(chunk); log(route, "Response body chunk: " + chunk); }
            if (text.toString().isBlank()) return JsonNull.INSTANCE;
            return JsonParser.parseString(text.toString());
        } finally { deadline.shutdownNow(); }
    }
    public JsonArray read(String id) throws Exception {
        JsonElement data = "POST".equals(readMethod) ? json("/history/read", object("conversation_id", id), "POST") : json("/history/read/" + URLEncoder.encode(id, StandardCharsets.UTF_8).replace("+", "%20"), null, "GET");
        JsonElement messages = data.isJsonArray() ? data : data.getAsJsonObject().get("messages");
        if (messages == null || !messages.isJsonArray()) throw new IOException("Unexpected message history response.");
        return messages.getAsJsonArray();
    }
    public Generation generate(JsonArray messages, String conversationId, Cancellation cancel, BiConsumer<String, JsonObject> onUpdate) throws Exception {
        JsonObject body = object("messages", messages);
        if (conversationId != null) { body.addProperty("conversation_id", conversationId); body.addProperty("generated", "false"); }
        StringBuilder content = new StringBuilder(); JsonObject metadata = new JsonObject(); JsonArray tools = new JsonArray(); String[] id = {""}; Usage[] usage = {null};
        Frames frames = new Frames(value -> {
            if (value.has("error") && !value.get("error").isJsonNull()) throw new IllegalArgumentException(string(value, "error").isEmpty() ? "Azure returned a generation error." : string(value, "error"));
            Usage next = usage(value.get("usage")); if (next != null) usage[0] = next;
            if (value.has("history_metadata") && value.get("history_metadata").isJsonObject()) value.getAsJsonObject("history_metadata").entrySet().forEach(entry -> metadata.add(entry.getKey(), entry.getValue()));
            if (!string(value, "id").isEmpty()) id[0] = string(value, "id");
            if (value.has("choices") && value.get("choices").isJsonArray() && !value.getAsJsonArray("choices").isEmpty()) {
                JsonObject choice = value.getAsJsonArray("choices").get(0).getAsJsonObject(); JsonArray items = new JsonArray();
                if (choice.has("messages") && choice.get("messages").isJsonArray()) items = choice.getAsJsonArray("messages");
                else if (choice.has("delta") && choice.get("delta").isJsonObject()) items.add(choice.get("delta"));
                else if (choice.has("message") && choice.get("message").isJsonObject()) items.add(choice.get("message"));
                for (JsonElement element : items) {
                    JsonObject item = element.getAsJsonObject(); String role = string(item, "role");
                    if (role.equals("tool")) {
                        JsonObject tool = item.deepCopy();
                        if (string(tool, "id").isEmpty()) tool.addProperty("id", id[0].isEmpty() ? UUID.randomUUID().toString() : id[0]);
                        if (string(tool, "date").isEmpty()) tool.addProperty("date", Instant.now().toString());
                        if (!tool.has("content")) tool.addProperty("content", ""); tools.add(tool);
                    } else if (role.isEmpty() || role.equals("assistant")) content.append(string(item, "content"));
                }
            }
            onUpdate.accept(content.toString(), metadata.deepCopy());
        });
        ScheduledExecutorService deadline = Executors.newSingleThreadScheduledExecutor();
        deadline.schedule(cancel::cancel, 180, TimeUnit.SECONDS);
        try (InputStream stream = request("/history/generate", body, "POST", cancel); Reader reader = new InputStreamReader(stream, StandardCharsets.UTF_8)) {
            char[] buffer = new char[4096]; int count;
            while ((count = reader.read(buffer)) != -1) { cancel.check(); String chunk = new String(buffer, 0, count); log("generate", "Response body chunk: " + chunk); frames.feed(chunk, false); }
            cancel.check(); frames.feed("", true);
        } finally { deadline.shutdownNow(); }
        if (content.isEmpty()) throw new IOException("The backend returned no assistant text.");
        JsonObject assistant = message("assistant", content.toString()); if (!id[0].isEmpty()) assistant.addProperty("id", id[0]);
        return new Generation(assistant, metadata, tools, usage[0]);
    }
    @Override public void close() { http.shutdownNow(); }
}
