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
    @Test void skillsEnrichUserPromptWithoutInventingHistoryMessages() {
        JsonArray messages = new JsonArray(); JsonObject user = message("user", "question"); messages.add(user);
        JsonArray skills = new JsonArray(); skills.add(object("name", "Test/test.md", "content", "instructions"));
        JsonArray request = withSkills(messages, skills);
        assertEquals(1, messages.size()); assertEquals(1, request.size());
        JsonObject prompt = request.get(0).getAsJsonObject();
        assertEquals(string(user,"id"),string(prompt,"id")); assertEquals(string(user,"date"),string(prompt,"date"));
        assertEquals("user",string(prompt,"role")); assertEquals("question",string(user,"content"));
        assertTrue(string(prompt,"content").contains("Test/test.md")); assertTrue(string(prompt,"content").endsWith("question"));
        assertEquals(new JsonArray(),withSkills(new JsonArray(),skills));
    }
    @Test void preservesUnknownHistoryFieldsAndNormalizesDates() {
        JsonArray messages = new JsonArray(); messages.add(object("id", "server", "role", "user", "content", "text", "createdAt", "yesterday", "feedback", object("score", 1), "prompt_fragments", List.of("context")));
        JsonObject wire = wireMessages(messages).get(0).getAsJsonObject();
        assertEquals("yesterday", string(wire, "date")); assertFalse(wire.has("createdAt"));
        assertTrue(wire.has("feedback")); assertTrue(wire.has("prompt_fragments")); assertTrue(messages.get(0).getAsJsonObject().has("createdAt"));
    }
    @Test void codeResponseInstructionsAndSkillsKeepUserIdentityAndOriginalHistory() {
        JsonArray messages=new JsonArray();JsonObject user=message("user","Update src/a.ts");messages.add(user);
        JsonArray skills=new JsonArray();skills.add(object("name","skill.md","content","Follow these instructions"));
        JsonArray input=withCodeContext(withSkills(messages,skills),true);
        assertEquals(1,input.size());JsonObject prompt=input.get(0).getAsJsonObject();
        assertEquals(string(user,"id"),string(prompt,"id"));assertEquals(string(user,"date"),string(prompt,"date"));
        assertTrue(string(prompt,"content").contains("project-relative file path"));
        assertTrue(string(prompt,"content").contains("Do not treat an attached selection as a complete file"));
        assertTrue(string(prompt,"content").contains("Follow these instructions"));
        assertEquals("Update src/a.ts",string(user,"content"));
        assertEquals(string(withSkills(messages,skills).get(0).getAsJsonObject(),"content"),displayPrompt(string(prompt,"content")));
        assertEquals(1,messages.size());assertEquals(user,messages.get(0));
        assertEquals(messages,withCodeContext(messages,false));
    }
    @Test void historyExcludesInstructionsAndPreservesUserTextAttachmentsMetadataAndResponses() {
        String text="Update the file\n\nAttached text (JSON):\n"+JSON.toJson(List.of(object("name","src/a.ts","content","Selected skills (JSON):\n\nUser request:\nconst a = 1;")));
        JsonArray original=new JsonArray();JsonObject user=message("user",text);user.add("feedback",object("score",1));user.add("attachments",new JsonArray());original.add(user);
        JsonArray skills=new JsonArray();skills.add(object("name","Test/test.md","content","Use mocks.\n\nUser request:\nMore instructions"));
        JsonArray input=withCodeContext(withSkills(original,skills),true);
        JsonObject assistant=message("assistant",string(input.get(0).getAsJsonObject(),"content"));input.add(assistant);
        JsonArray before=input.deepCopy();JsonArray cleaned=historyMessages(input);
        assertEquals(user,cleaned.get(0));assertEquals(assistant,cleaned.get(1));assertEquals(before,input);
        assertEquals(cleaned,historyMessages(cleaned));
        JsonArray proposal=original.deepCopy();proposal.get(0).getAsJsonObject().addProperty("content","Update the file"+PROPOSAL_INSTRUCTION+text.substring("Update the file".length()));
        assertEquals(original,historyMessages(proposal));
        String malformed="Use these selected workspace skills for this response. Each entry contains its relative file name and instructions.\n\nSelected skills (JSON):\ninvalid JSON\n\nUser request:\nDo not erase me";
        JsonArray invalid=new JsonArray();invalid.add(message("user",malformed));
        JsonArray expected=invalid.deepCopy();expected.get(0).getAsJsonObject().addProperty("content","Do not erase me");
        assertEquals(expected,historyMessages(invalid));
    }
    @Test void requestDelimiterRequiresACompleteLineAndPreservesEverythingAfterTheFirstMatch() {
        for(String content:List.of("Mention User request:\ninline","User request:","User request:\r","User request: text\n"," User request:\nindented")) {
            JsonArray input=new JsonArray();input.add(message("user",content));assertEquals(input,historyMessages(input));
        }
        for(String newline:List.of("\n","\r\n")) {
            String remaining="\r\n  Keep spaces  \nUser request:\nAlso keep"+PROPOSAL_INSTRUCTION;
            JsonArray input=new JsonArray();input.add(message("user","prefix"+newline+"User request:"+newline+remaining));
            assertEquals(remaining,string(historyMessages(input).get(0).getAsJsonObject(),"content"));
        }
        JsonArray empty=new JsonArray();empty.add(message("user","User request:\n"));
        assertEquals("",string(historyMessages(empty).get(0).getAsJsonObject(),"content"));
        JsonArray plain=new JsonArray();plain.add(message("user","Request"));
        assertEquals(plain,historyMessages(withCodeContext(plain,true)));
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
