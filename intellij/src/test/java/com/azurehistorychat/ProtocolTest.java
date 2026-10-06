package com.azurehistorychat;

import com.google.gson.*;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import java.nio.file.*;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static com.azurehistorychat.Protocol.*;

class ProtocolTest {
    @TempDir Path directory;
    @Test void consumesFragmentedSseAdjacentJsonAndEscapedBraces() {
        List<JsonObject> seen = new ArrayList<>(); Frames frames = new Frames(seen::add);
        String transport = ": keepalive\nevent: message\nid: 1\nretry: 10\ndata: {\"content\":\"hé😀}\\\"{\",\"nested\":[{}]}\n\ndata: {\"n\":2}{\"n\":3}\n[DONE]";
        for (int i = 0; i < transport.length(); i++) frames.feed(transport.substring(i, i + 1), false);
        frames.feed("", true);
        assertEquals(3, seen.size()); assertEquals("hé😀}\"{", seen.getFirst().get("content").getAsString());
    }
    @Test void rejectsIncompleteAndUnexpectedResponses() {
        Frames frames = new Frames(value -> {});
        assertThrows(IllegalArgumentException.class, () -> frames.feed("{\"choices\":[]", true));
        assertThrows(IllegalArgumentException.class, () -> new Frames(value -> {}).feed("<html>error</html>", true));
    }
    @ParameterizedTest @ValueSource(strings = {"../x", "/etc/test", "C:\\test", "x/../../y", "x//y", ".git/config", "folder/.AWS/key", "x\\.codex\\config", "x/.agents/a", "NUL.txt", "x/COM1", "a:stream", "a/.", "a/..", "a./b", "a /b", "a?b", "a|b", "a\nb", "a\nb\nc"})
    void rejectsUnsafePaths(String path) { assertThrows(IllegalArgumentException.class, () -> safePath(path)); }
    @Test void parsesMultipleBlocksAndRejectsCaseInsensitiveDuplicates() {
        String block = "```azure-files\n{\"files\":[{\"path\":\"src\\\\test.java\",\"content\":\"hello\\n\"}]}\n```";
        assertEquals(new FileChange("src/test.java", "hello\n"), changes(block).getFirst());
        assertThrows(IllegalArgumentException.class, () -> changes(block + block.replace("test.java", "TEST.java")));
        assertThrows(RuntimeException.class, () -> changes("```azure-files\n{\"files\":[{\"path\":\"a\",\"content\":42}]}\n```"));
    }
    @Test void skillsOnlyEnterGenerationAndLeaveFinalUserMessageUnchanged() {
        JsonArray messages = new JsonArray(); JsonObject user = message("user", "question"); messages.add(user);
        JsonArray skills = new JsonArray(); skills.add(object("name", "Test/test.md", "content", "instructions"));
        JsonArray request = withSkills(messages, skills);
        assertEquals(1, messages.size()); assertEquals(2, request.size());
        assertEquals(user, request.get(1)); assertEquals("system", string(request.get(0).getAsJsonObject(), "role"));
    }
    @Test void preservesUnknownHistoryFieldsAndNormalizesDates() {
        JsonArray messages = new JsonArray(); messages.add(object("id", "server", "role", "user", "content", "text", "createdAt", "yesterday", "feedback", object("score", 1), "prompt_fragments", List.of("context")));
        JsonObject wire = wireMessages(messages).get(0).getAsJsonObject();
        assertEquals("yesterday", string(wire, "date")); assertFalse(wire.has("createdAt"));
        assertTrue(wire.has("feedback")); assertTrue(wire.has("prompt_fragments")); assertTrue(messages.get(0).getAsJsonObject().has("createdAt"));
    }
    @Test void codeResponseInstructionsAreTransientAndKeepFinalUserMessage() {
        JsonArray messages=new JsonArray();JsonObject user=message("user","Update src/a.ts");messages.add(user);
        JsonArray skills=new JsonArray();skills.add(object("name","skill.md","content","Follow these instructions"));
        JsonArray input=withCodeContext(withSkills(messages,skills),true);
        assertEquals(3,input.size());assertEquals(user,input.get(2));
        assertEquals("code-response-format",string(input.get(1).getAsJsonObject(),"id"));
        assertTrue(string(input.get(1).getAsJsonObject(),"content").contains("project-relative file path"));
        assertTrue(string(input.get(1).getAsJsonObject(),"content").contains("Do not treat an attached selection as a complete file"));
        assertEquals(1,messages.size());assertEquals(user,messages.get(0));
        assertEquals(messages,withCodeContext(messages,false));
    }
    @Test void countsUtf8AndValidatesUsage() {
        assertEquals(2, estimate("😀é"));
        assertEquals(new Usage(8, 2, 10), usage(object("prompt_tokens", 8, "completion_tokens", 2, "total_tokens", 9)));
        assertNull(usage(object("prompt_tokens", -1, "completion_tokens", 2)));
        assertNull(usage(object("prompt_tokens", "8", "completion_tokens", 2)));
        assertNull(usage(object("prompt_tokens", 1.5, "completion_tokens", 2)));
    }
    @Test void validatesNewTargetsAndRejectsExternalSymlinks() throws Exception {
        Path root = Files.createDirectory(directory.resolve("project"));
        assertEquals(root.resolve("new/file.java"), validateTarget(root, root.resolve("new/file.java")));
        assertThrows(java.io.IOException.class, () -> validateTarget(root, directory.resolve("outside")));
        Path outside = Files.createDirectory(directory.resolve("outside"));
        try { Files.createSymbolicLink(root.resolve("link"), outside); }
        catch (Exception unsupported) { Assumptions.abort("Symlinks require permission on this host."); }
        assertThrows(java.io.IOException.class, () -> validateTarget(root, root.resolve("link/new.java")));
    }
}
