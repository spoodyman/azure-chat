package com.azurehistorychat;

import com.google.gson.*;
import com.sun.net.httpserver.*;
import org.junit.jupiter.api.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import static org.junit.jupiter.api.Assertions.*;
import static com.azurehistorychat.Protocol.*;

class AzureClientTest {
    private HttpServer server;
    private String base;
    private final List<JsonObject> bodies = new CopyOnWriteArrayList<>();
    private final List<String> routes = new CopyOnWriteArrayList<>();
    @BeforeEach void start() throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            routes.add(exchange.getRequestMethod() + " " + exchange.getRequestURI());
            assertEquals("Bearer private-token", exchange.getRequestHeaders().getFirst("Authorization"));
            String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            if (!body.isEmpty()) bodies.add(JsonParser.parseString(body).getAsJsonObject());
            String path = exchange.getRequestURI().getPath();
            if (path.equals("/redirect")) { exchange.getResponseHeaders().set("Location", base + "/should-not-follow"); exchange.sendResponseHeaders(302, -1); exchange.close(); return; }
            if (path.equals("/error")) { respond(exchange, 403, "{\"error\":\"private-token denied\"}"); return; }
            if (path.equals("/history/list")) { respond(exchange, 200, "[{\"id\":\"chat\",\"title\":\"Title\"}]"); return; }
            if (path.startsWith("/history/read")) { respond(exchange, 200, "{\"messages\":[{\"id\":\"server-user\",\"role\":\"user\",\"content\":\"earlier\",\"feedback\":{\"score\":1}}]}"); return; }
            if (path.equals("/history/generate")) {
                exchange.getResponseHeaders().set("Content-Type", "text/event-stream"); exchange.sendResponseHeaders(200, 0);
                String transport = "data: {\"id\":\"answer-id\",\"history_metadata\":{\"conversation_id\":\"chat\"},\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"hé😀\"}}]}\n\ndata: {\"choices\":[{\"messages\":[{\"role\":\"tool\",\"content\":\"retrieval\"},{\"role\":\"assistant\",\"content\":\" done\"}]}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":3,\"total_tokens\":13}}\n\ndata: [DONE]\n";
                for (byte part : transport.getBytes(StandardCharsets.UTF_8)) { exchange.getResponseBody().write(part); exchange.getResponseBody().flush(); }
                exchange.close(); return;
            }
            respond(exchange, 200, "{}");
        });
        server.start(); base = "http://127.0.0.1:" + server.getAddress().getPort();
    }
    private static void respond(HttpExchange exchange, int status, String text) throws java.io.IOException {
        byte[] data = text.getBytes(StandardCharsets.UTF_8); exchange.getResponseHeaders().set("Content-Type", "application/json"); exchange.sendResponseHeaders(status, data.length); exchange.getResponseBody().write(data); exchange.close();
    }
    @AfterEach void stop() { server.stop(0); }
    @Test void followsHistoryContractAndPreservesResponseMetadata() throws Exception {
        try (AzureClient client = new AzureClient(base, "private-token", "GET", null)) {
            assertEquals(1, client.json("/history/list?offset=0", null, "GET").getAsJsonArray().size());
            JsonArray messages = client.read("chat"); messages.add(message("user", "follow-up"));
            AzureClient.Generation response = client.generate(messages, "chat", new AzureClient.Cancellation(), (text, metadata) -> {});
            assertEquals("hé😀 done", string(response.message(), "content")); assertEquals("answer-id", string(response.message(), "id"));
            assertEquals("chat", string(response.metadata(), "conversation_id")); assertEquals(1, response.tools().size()); assertEquals(new Usage(10, 3, 13), response.usage());
            messages.add(response.message()); client.json("/history/update", object("conversation_id", "chat", "messages", messages), "POST");
            client.json("/history/delete", object("conversation_id", "chat"), "DELETE");
            assertEquals("false", string(bodies.getFirst(), "generated")); assertTrue(bodies.getFirst().getAsJsonArray("messages").get(0).getAsJsonObject().has("feedback"));
            assertEquals(List.of("GET /history/list?offset=0", "GET /history/read/chat", "POST /history/generate", "POST /history/update", "DELETE /history/delete"), routes);
        }
    }
    @Test void skillsGenerateWithoutSyntheticHistoryAndUpdatesExcludeInstructions() throws Exception {
        server.createContext("/history/generate", exchange -> {
            JsonObject body=JsonParser.parseString(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8)).getAsJsonObject();
            bodies.add(body);
            for(JsonElement value:body.getAsJsonArray("messages")) {
                JsonObject item=value.getAsJsonObject();
                if(string(item,"role").equals("system") || string(item,"id").isEmpty() || string(item,"date").isEmpty()) {
                    respond(exchange,500,"{\"error\":\"Error collecting message history\"}");return;
                }
            }
            respond(exchange,200,"{\"id\":\"answer\",\"history_metadata\":{\"conversation_id\":\"chat\"},\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":\"Done\"}}]}");
        });
        JsonArray original=new JsonArray();original.add(message("user","Write tests"));
        JsonArray skills=new JsonArray();skills.add(object("name","Test/test.md","content","Use a fake service."));
        JsonArray input=withCodeContext(withSkills(original,skills),true);
        try(AzureClient client=new AzureClient(base,"private-token","GET",null)) {
            AzureClient.Generation response=client.generate(input,null,new AzureClient.Cancellation(),(text,metadata)->{});
            JsonArray saved=input.deepCopy();saved.add(response.message());
            client.json("/history/update",object("conversation_id","chat","messages",saved),"POST");
            assertEquals(1,bodies.getFirst().getAsJsonArray("messages").size());
            assertEquals(original.get(0),bodies.getLast().getAsJsonArray("messages").get(0));
            assertTrue(string(input.get(0).getAsJsonObject(),"content").contains("Use a fake service."));
            assertEquals("Write tests",string(original.get(0).getAsJsonObject(),"content"));
        }
    }
    @Test void supportsPostReadAndNewConversationRequests() throws Exception {
        try (AzureClient client = new AzureClient(base, "private-token", "POST", null)) {
            client.read("chat"); assertEquals("chat", string(bodies.getFirst(), "conversation_id"));
            JsonArray messages = new JsonArray(); messages.add(message("user", "hello"));
            client.generate(messages, null, new AzureClient.Cancellation(), (text, metadata) -> {});
            assertFalse(bodies.get(1).has("conversation_id")); assertFalse(bodies.get(1).has("generated"));
        }
    }
    @Test void redactsSecretsAndRejectsRedirects() throws Exception {
        List<String> logs = new ArrayList<>();
        try (AzureClient client = new AzureClient(base, "private-token", "GET", logs::add)) {
            Exception error = assertThrows(Exception.class, () -> client.json("/error", null, "GET"));
            assertTrue(error.getMessage().contains("403")); assertFalse(error.getMessage().contains("private-token"));
            assertTrue(logs.stream().noneMatch(line -> line.contains("private-token")));
            assertThrows(Exception.class, () -> client.json("/redirect", null, "GET"));
            assertTrue(routes.stream().noneMatch(route -> route.contains("should-not-follow")));
        }
    }
    @Test void cancellationStopsAnActiveStream() throws Exception {
        CountDownLatch opened = new CountDownLatch(1), release = new CountDownLatch(1);
        server.removeContext("/");
        server.createContext("/history/generate", exchange -> {
            exchange.sendResponseHeaders(200, 0);
            exchange.getResponseBody().write("data: {}\n".getBytes(StandardCharsets.UTF_8)); exchange.getResponseBody().flush(); opened.countDown();
            try { release.await(5, TimeUnit.SECONDS); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
            exchange.close();
        });
        try (AzureClient client = new AzureClient(base, "private-token", "GET", null)) {
            AzureClient.Cancellation cancel = new AzureClient.Cancellation();
            CompletableFuture<Void> result = CompletableFuture.runAsync(() -> {
                try { client.generate(new JsonArray(), null, cancel, (text, metadata) -> {}); fail("Expected cancellation"); }
                catch (Exception expected) { assertTrue(cancel.isCancelled()); }
            });
            assertTrue(opened.await(3, TimeUnit.SECONDS)); cancel.cancel(); release.countDown(); result.get(3, TimeUnit.SECONDS);
        } finally { release.countDown(); }
    }
    @Test void rejectsUnsafeConnectionUrls() {
        for (String url : List.of("http://example.com", "https://user:password@example.com", "https://example.com?q=x", "https://example.com#x", "file:///tmp/file", "not-a-url")) assertThrows(IllegalArgumentException.class, () -> AzureClient.validateUrl(url));
        assertEquals("https://example.com/app", AzureClient.validateUrl("https://example.com/app/"));
    }
}
