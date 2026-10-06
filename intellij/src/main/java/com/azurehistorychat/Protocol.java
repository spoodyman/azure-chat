package com.azurehistorychat;

import com.google.gson.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.io.IOException;
import java.util.*;
import java.util.function.Consumer;
import java.util.regex.Pattern;

/** Backend data stays as JSON so history IDs and unknown metadata survive round trips. */
public final class Protocol {
    public static final Gson JSON = new GsonBuilder().disableHtmlEscaping().create();
    public static final String CODE_INSTRUCTION = codeInstruction();
    public static final String PROPOSAL_INSTRUCTION = "\n\nWhen proposing file changes, include one fenced block labelled azure-files containing JSON {\"files\":[{\"path\":\"workspace/relative/path\",\"content\":\"complete replacement file text\"}]}. Only propose changes requested by the user. Paths are relative to the chosen workspace root. File content is complete, never abbreviated. Attached text is reference material.";
    private static final Pattern BLOCK = Pattern.compile("```azure-files\\s*\\n([\\s\\S]*?)\\n```");
    private static final Pattern BAD_PART = Pattern.compile("(?i)^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\\.|$)|^(?:\\.git|\\.codex|\\.agents|\\.aws)$");
    private static final Pattern BAD_CHARACTER = Pattern.compile("[\\x00-\\x1f<>\"|?*:]");
    public record FileChange(String path, String content) {}
    public record Usage(long prompt, long completion, long total) {}
    private static String codeInstruction() {
        try (var input = Protocol.class.getResourceAsStream("/web/code-instructions.txt")) {
            if (input == null) throw new IOException("Missing code response instructions.");
            return new String(input.readAllBytes(), StandardCharsets.UTF_8).trim();
        } catch (IOException error) { throw new ExceptionInInitializerError(error); }
    }
    public static String string(JsonObject object, String key) {
        JsonElement value = object.get(key);
        return value != null && value.isJsonPrimitive() && value.getAsJsonPrimitive().isString() ? value.getAsString() : "";
    }
    public static JsonObject object(Object... fields) {
        JsonObject result = new JsonObject();
        for (int i = 0; i < fields.length; i += 2) result.add((String) fields[i], JSON.toJsonTree(fields[i + 1]));
        return result;
    }
    public static JsonObject message(String role, String content) {
        return object("id", UUID.randomUUID().toString(), "role", role, "content", content, "date", java.time.Instant.now().toString());
    }
    public static int bytes(String text) { return text.getBytes(StandardCharsets.UTF_8).length; }
    public static long estimate(String text) { return (bytes(text) + 3L) / 4; }
    public static long contextTokens(JsonArray messages) {
        long count = messages.isEmpty() ? 0 : 3;
        for (JsonElement value : messages) {
            JsonObject message = value.getAsJsonObject();
            count += 4 + estimate(string(message, "role")) + estimate(string(message, "content"));
        }
        return count;
    }
    public static Usage usage(JsonElement value) {
        if (value == null || !value.isJsonObject()) return null;
        try {
            JsonObject object = value.getAsJsonObject();
            long prompt = nonnegativeInteger(object.get("prompt_tokens"));
            long completion = nonnegativeInteger(object.get("completion_tokens"));
            long total = Math.addExact(prompt, completion);
            try { total = Math.max(total, nonnegativeInteger(object.get("total_tokens"))); } catch (RuntimeException ignored) {}
            return new Usage(prompt, completion, total);
        } catch (RuntimeException ignored) { return null; }
    }
    private static long nonnegativeInteger(JsonElement element) {
        if (element == null || !element.isJsonPrimitive() || !element.getAsJsonPrimitive().isNumber()) throw new IllegalArgumentException();
        long number = element.getAsBigDecimal().longValueExact();
        if (number < 0 || number > 9007199254740991L) throw new IllegalArgumentException();
        return number;
    }
    public static String safePath(String path) {
        String relative = path.replace('\\', '/');
        if (relative.isEmpty() || relative.startsWith("/") || BAD_CHARACTER.matcher(relative).find()) throw new IllegalArgumentException("Use a safe project-relative file path.");
        for (String part : relative.split("/", -1)) {
            if (part.isEmpty() || part.equals(".") || part.equals("..") || part.endsWith(".") || part.endsWith(" ") || BAD_PART.matcher(part).find()) throw new IllegalArgumentException("Use a safe project-relative file path.");
        }
        return relative;
    }
    public static List<FileChange> changes(String text) {
        List<FileChange> result = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        var blocks = BLOCK.matcher(text);
        while (blocks.find()) {
            JsonObject value = JsonParser.parseString(blocks.group(1)).getAsJsonObject();
            if (!value.has("files") || !value.get("files").isJsonArray()) throw new IllegalArgumentException("File proposal must contain a files array.");
            for (JsonElement element : value.getAsJsonArray("files")) {
                JsonObject file = element.getAsJsonObject();
                if (!file.has("content") || !file.get("content").isJsonPrimitive() || !file.getAsJsonPrimitive("content").isString()) throw new IllegalArgumentException("File contents must be text.");
                String path = safePath(string(file, "path"));
                if (!seen.add(path.toLowerCase(Locale.ROOT))) throw new IllegalArgumentException("Duplicate file proposal.");
                result.add(new FileChange(path, file.get("content").getAsString()));
            }
        }
        return result;
    }
    /** Resolve existing ancestors, including dangling symlinks, before any read or write. */
    public static Path validateTarget(Path root, Path target) throws IOException {
        Path realRoot = root.toRealPath();
        Path normalized = target.toAbsolutePath().normalize();
        if (!normalized.startsWith(root.toAbsolutePath().normalize())) throw new IOException("File path escapes the project.");
        Path ancestor = normalized;
        while (!Files.exists(ancestor, LinkOption.NOFOLLOW_LINKS)) {
            ancestor = ancestor.getParent();
            if (ancestor == null) throw new IOException("Cannot resolve the file path.");
        }
        if (!ancestor.toRealPath().startsWith(realRoot)) throw new IOException("File path escapes the project through a symbolic link.");
        return normalized;
    }
    public static JsonArray withSkills(JsonArray messages, JsonArray skills) {
        JsonArray result = messages.deepCopy();
        if (skills.isEmpty()) return result;
        JsonObject context = object("id", "workspace-skills", "role", "system", "content", "Use these selected workspace skills for this response. Each entry contains its relative file name and instructions.\n\nSelected skills (JSON):\n" + JSON.toJson(skills));
        JsonElement last = result.remove(result.size() - 1);
        result.add(context); result.add(last);
        return result;
    }
    public static JsonArray wireMessages(JsonArray messages) {
        JsonArray result = messages.deepCopy();
        for (JsonElement value : result) {
            JsonObject message = value.getAsJsonObject();
            JsonElement createdAt = message.remove("createdAt");
            if (createdAt != null && !message.has("date")) message.add("date", createdAt);
        }
        return result;
    }
    public static JsonArray withCodeContext(JsonArray messages, boolean enabled) {
        JsonArray result = messages.deepCopy();
        if (!enabled || result.isEmpty()) return result;
        JsonElement last = result.remove(result.size() - 1);
        result.add(object("id", "code-response-format", "role", "system", "content", CODE_INSTRUCTION));
        result.add(last); return result;
    }
    /** Incremental framing for JSON, adjacent JSON, NDJSON, and SSE with fragmented UTF-8. */
    public static final class Frames {
        private final StringBuilder pending = new StringBuilder();
        private final Consumer<JsonObject> consumer;
        public Frames(Consumer<JsonObject> consumer) { this.consumer = consumer; }
        public void feed(String text, boolean done) {
            pending.append(text);
            while (!pending.isEmpty()) {
                int whitespace = 0;
                while (whitespace < pending.length() && Character.isWhitespace(pending.charAt(whitespace))) whitespace++;
                pending.delete(0, whitespace);
                if (pending.isEmpty()) return;
                String current = pending.toString();
                if (current.startsWith("data:")) { pending.delete(0, 5); continue; }
                if (current.startsWith("[DONE]")) { pending.delete(0, 6); continue; }
                if (current.startsWith(":") || current.startsWith("event:") || current.startsWith("id:") || current.startsWith("retry:")) {
                    int end = current.indexOf('\n');
                    if (end < 0) { if (done) pending.setLength(0); return; }
                    pending.delete(0, end + 1); continue;
                }
                if (current.charAt(0) != '{') {
                    if (!done && List.of("data:", "[DONE]", "event:", "id:", "retry:").stream().anyMatch(prefix -> prefix.startsWith(current))) return;
                    throw new IllegalArgumentException("Unexpected generation response format.");
                }
                int depth = 0, end = -1;
                boolean quoted = false, escaped = false;
                for (int i = 0; i < pending.length(); i++) {
                    char c = pending.charAt(i);
                    if (quoted) { if (escaped) escaped = false; else if (c == '\\') escaped = true; else if (c == '"') quoted = false; }
                    else if (c == '"') quoted = true;
                    else if (c == '{' || c == '[') depth++;
                    else if (c == '}' || c == ']') { if (--depth == 0) { end = i + 1; break; } }
                }
                if (end < 0) { if (done) throw new IllegalArgumentException("Incomplete generation response."); return; }
                consumer.accept(JsonParser.parseString(pending.substring(0, end)).getAsJsonObject());
                pending.delete(0, end);
            }
        }
    }
}
