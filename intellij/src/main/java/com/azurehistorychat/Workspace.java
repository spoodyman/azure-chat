package com.azurehistorychat;

import com.google.gson.*;
import com.intellij.ide.impl.TrustedProjects;
import com.intellij.diff.DiffContentFactory;
import com.intellij.diff.DiffManager;
import com.intellij.diff.requests.SimpleDiffRequest;
import com.intellij.openapi.application.*;
import com.intellij.openapi.command.WriteCommandAction;
import com.intellij.openapi.editor.*;
import com.intellij.openapi.fileEditor.*;
import com.intellij.openapi.fileTypes.FileTypeManager;
import com.intellij.openapi.fileTypes.PlainTextFileType;
import com.intellij.testFramework.LightVirtualFile;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.roots.ProjectRootManager;
import com.intellij.openapi.ui.*;
import com.intellij.openapi.vfs.*;
import org.jetbrains.annotations.Nullable;
import javax.swing.*;
import java.io.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.Callable;
import java.util.concurrent.atomic.AtomicReference;
import static com.azurehistorychat.Protocol.*;

final class Workspace {
    private final Project project;
    record Skill(String id, String name, Path path, Path root) {}
    record EditorText(VirtualFile file, String name, String content) {}
    Workspace(Project project) { this.project = project; }
    boolean trusted() { return TrustedProjects.isTrusted(project); }
    void requireTrust() { if (!trusted()) throw new IllegalStateException("Trust the project before using files, skills, or file proposals."); }
    static <T> T ui(Callable<T> action) throws Exception {
        if (ApplicationManager.getApplication().isDispatchThread()) return action.call();
        AtomicReference<T> result = new AtomicReference<>(); AtomicReference<Exception> error = new AtomicReference<>();
        ApplicationManager.getApplication().invokeAndWait(() -> { try { result.set(action.call()); } catch (Exception value) { error.set(value); } }, ModalityState.any());
        if (error.get() != null) throw error.get();
        return result.get();
    }
    List<Path> roots() {
        return ReadAction.compute(() -> {
            LinkedHashSet<Path> paths = new LinkedHashSet<>();
            if (project.getBasePath() != null) paths.add(Path.of(project.getBasePath()).toAbsolutePath().normalize());
            for (VirtualFile file : ProjectRootManager.getInstance(project).getContentRoots()) {
                Path path = Path.of(file.getPath()).toAbsolutePath().normalize();
                if (paths.stream().noneMatch(path::startsWith)) paths.add(path);
            }
            return new ArrayList<>(paths);
        });
    }
    Path chooseRoot() throws Exception {
        List<Path> paths = roots();
        if (paths.isEmpty()) throw new IOException("Open a local project first.");
        if (paths.size() == 1) return paths.getFirst();
        return ui(() -> {
            RootDialog dialog = new RootDialog(project, paths);
            return dialog.showAndGet() ? dialog.selected() : null;
        });
    }
    private String name(VirtualFile file) {
        Path path = Path.of(file.getPath());
        for (Path root : roots()) if (path.startsWith(root)) return root.relativize(path).toString().replace('\\', '/');
        return file.getName();
    }
    EditorText editor(boolean selection) throws Exception {
        requireTrust();
        return ui(() -> {
            Editor editor = FileEditorManager.getInstance(project).getSelectedTextEditor();
            if (editor == null || editor.isDisposed()) throw new IOException("Open a text file in an editor first.");
            VirtualFile file = FileDocumentManager.getInstance().getFile(editor.getDocument());
            if (file == null || !file.isInLocalFileSystem()) throw new IOException("Select a local text file.");
            String label = name(file), content = editor.getDocument().getText();
            if (selection) {
                SelectionModel selected = editor.getSelectionModel();
                if (!selected.hasSelection()) throw new IOException("Select text in an editor first.");
                label += ":" + (editor.getDocument().getLineNumber(selected.getSelectionStart()) + 1) + "-" + (editor.getDocument().getLineNumber(selected.getSelectionEnd()) + 1);
                content = selected.getSelectedText();
            }
            return new EditorText(file, label, content);
        });
    }
    String text(Path path, long remaining) throws Exception {
        String edited = ReadAction.compute(() -> {
            VirtualFile file = LocalFileSystem.getInstance().findFileByNioFile(path);
            Document document = file == null ? null : FileDocumentManager.getInstance().getCachedDocument(file);
            return document == null ? null : document.getText();
        });
        if (edited != null) { validateText(edited, remaining); return edited; }
        if (Files.size(path) > remaining) throw new IOException("Skills and attachments exceed the configured byte limit.");
        // Bound reads as files can grow between the size check and read.
        try (InputStream input = Files.newInputStream(path)) {
            byte[] data = input.readNBytes((int) Math.min(Integer.MAX_VALUE - 1L, Math.max(0, remaining) + 1));
            String result = new String(data, java.nio.charset.StandardCharsets.UTF_8); validateText(result, remaining); return result;
        }
    }
    void openCode(String text, String path, String language) throws Exception {
        if (bytes(text)>5000000) throw new IOException("Code preview exceeds the 5 MB limit.");
        Map<String,String> extensions=Map.of("typescript","ts","javascript","js","python","py","kotlin","kt","csharp","cs","bash","sh","powershell","ps1","patch","diff");
        String name=path.isEmpty() ? "code." + extensions.getOrDefault(language,language.isEmpty() ? "txt" : language.replaceAll("[^a-zA-Z0-9]", "")) : path.replace('\\','/').substring(path.replace('\\','/').lastIndexOf('/')+1).replaceAll("[^a-zA-Z0-9._-]", "_") + (language.equals("diff") || language.equals("patch") ? ".diff" : "");
        ui(() -> {
            var type=FileTypeManager.getInstance().getFileTypeByFileName(name);
            LightVirtualFile preview=new LightVirtualFile(name,type.isBinary() ? PlainTextFileType.INSTANCE : type,text.replace("\r\n","\n").replace('\r','\n'));
            preview.setWritable(false);
            FileEditorManager.getInstance(project).openFile(preview,true); return null;
        });
    }
    static void validateText(String text, long remaining) throws IOException {
        if (text.indexOf('\0') >= 0) throw new IOException("Only text files and skills can be attached.");
        if (bytes(text) > remaining) throw new IOException("Skills and attachments exceed the configured byte limit.");
    }
    List<Skill> discover() throws Exception {
        List<Skill> result = new ArrayList<>();
        if (!trusted()) return result;
        List<Path> roots = roots();
        for (Path root : roots) {
            Path directory = root.resolve("skills");
            if (!Files.exists(directory, LinkOption.NOFOLLOW_LINKS)) continue;
            validateTarget(root, directory);
            try (var paths = Files.walk(directory)) {
                for (Path path : paths.filter(file -> Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS) && file.toString().matches("(?i).*\\.(md|json)$")).toList()) {
                    validateTarget(root, path); validateTarget(directory, path);
                    String name = (roots.size() > 1 ? root.getFileName() + "/" : "") + directory.relativize(path).toString().replace('\\', '/');
                    result.add(new Skill(path.toUri().toString(), name, path, root));
                }
            }
        }
        result.sort(Comparator.comparing(Skill::name)); return result;
    }
    JsonArray skillContents(List<Skill> available, Set<String> selected, long limit) throws Exception {
        JsonArray result = new JsonArray(); if (!selected.isEmpty()) requireTrust();
        long used = 0;
        for (String id : selected) {
            Skill skill = available.stream().filter(value -> value.id().equals(id)).findFirst().orElseThrow(() -> new IOException("A selected skill is no longer available."));
            validateTarget(skill.root(), skill.path()); validateTarget(skill.root().resolve("skills"), skill.path());
            String content = text(skill.path(), limit - used); used += bytes(content);
            result.add(object("name", skill.name(), "content", content));
        }
        return result;
    }
    void createSkill() throws Exception {
        requireTrust(); Path root = chooseRoot(); if (root == null) return;
        String value = ui(() -> Messages.showInputDialog(project, "Path inside skills, for example Test/write-unit-test.md", "New Workspace Skill", Messages.getQuestionIcon()));
        if (value == null) return;
        String relative = safePath(value);
        if (!relative.matches("(?i).*\\.(md|json)$")) throw new IOException("Skill files must end in .md or .json.");
        Path directory = root.resolve("skills"), target = directory.resolve(relative);
        validateTarget(root, target);
        if (Files.exists(directory)) validateTarget(directory, target);
        Files.createDirectories(target.getParent());
        validateTarget(root, target); validateTarget(directory, target);
        String content = relative.toLowerCase(Locale.ROOT).endsWith(".json") ? "{\n  \"instructions\": \"Describe how to perform this skill.\"\n}\n" : "# " + target.getFileName().toString().replaceFirst("(?i)\\.md$", "") + "\n\nDescribe how to perform this skill.\n";
        Files.writeString(target, content, StandardOpenOption.CREATE_NEW);
        VirtualFile file = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(target);
        if (file != null) ui(() -> { FileEditorManager.getInstance(project).openFile(file, true); return null; });
    }
    void review(String reply) throws Exception {
        requireTrust(); List<FileChange> changes = changes(reply);
        if (changes.isEmpty()) throw new IOException("No azure-files proposal found in this response.");
        Path root = chooseRoot(); if (root == null) return;
        // Validate the entire proposal before showing any application controls.
        for (FileChange change : changes) validateTarget(root, root.resolve(change.path()));
        for (FileChange change : changes) {
            Path target = root.resolve(change.path()); validateTarget(root, target);
            VirtualFile originalFile = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(target);
            Document originalDocument = originalFile == null ? null : ReadAction.compute(() -> FileDocumentManager.getInstance().getDocument(originalFile));
            if (originalFile != null && (originalFile.isDirectory() || originalDocument == null)) throw new IOException("Target cannot be opened as text: " + change.path());
            String original = originalDocument == null ? "" : ReadAction.compute(originalDocument::getText);
            long stamp = originalDocument == null ? -1 : originalDocument.getModificationStamp();
            boolean apply = ui(() -> {
                DiffContentFactory factory = DiffContentFactory.getInstance();
                SimpleDiffRequest request = new SimpleDiffRequest(change.path() + " — proposed change", factory.create(project, original), factory.create(project, change.content()), "Current file", "Proposed file");
                ProposalDialog dialog = new ProposalDialog(project, request); return dialog.showAndGet();
            });
            if (!apply) continue;
            requireTrust(); validateTarget(root, target);
            ui(() -> {
                WriteCommandAction.writeCommandAction(project).withName("Apply Azure Chat file proposal").run(() -> {
                    try {
                        requireTrust(); validateTarget(root, target);
                        Document document = originalDocument;
                        if (document != null) {
                            if (!originalFile.isValid() || document.getModificationStamp() != stamp || !document.getText().equals(original)) throw new IOException("The file changed during review. Review the proposal again.");
                            if (!originalFile.isWritable()) throw new IOException("The target is read-only.");
                        } else {
                            if (Files.exists(target, LinkOption.NOFOLLOW_LINKS)) throw new IOException("The target was created during review. Review again.");
                            VirtualFile parent = VfsUtil.createDirectoryIfMissing(target.getParent().toString());
                            if (parent == null) throw new IOException("Cannot create the parent directory.");
                            validateTarget(root, target);
                            VirtualFile created = parent.createChildData(this, target.getFileName().toString());
                            document = FileDocumentManager.getInstance().getDocument(created);
                            if (document == null) throw new IOException("Cannot open the new text document.");
                            FileEditorManager.getInstance(project).openFile(created, true);
                        }
                        document.setText(change.content());
                        if (originalFile != null) FileEditorManager.getInstance(project).openFile(originalFile, true);
                    } catch (IOException error) { throw new IllegalStateException(error.getMessage(), error); }
                });
                return null;
            });
        }
    }
    private static final class ProposalDialog extends DialogWrapper {
        private final SimpleDiffRequest request;
        private final Project project;
        ProposalDialog(Project project, SimpleDiffRequest request) { super(project); this.project = project; this.request = request; setTitle(request.getTitle()); setOKButtonText("Apply"); init(); }
        @Override protected @Nullable JComponent createCenterPanel() {
            var panel = DiffManager.getInstance().createRequestPanel(project, getDisposable(), null);
            panel.setRequest(request);
            JComponent component = panel.getComponent(); component.setPreferredSize(new java.awt.Dimension(900, 600)); return component;
        }
    }
    private static final class RootDialog extends DialogWrapper {
        private final JComboBox<Path> roots;
        RootDialog(Project project, List<Path> paths) { super(project); roots = new JComboBox<>(paths.toArray(Path[]::new)); setTitle("Choose Project Root"); init(); }
        Path selected() { return (Path) roots.getSelectedItem(); }
        @Override protected @Nullable JComponent createCenterPanel() {
            JPanel panel = new JPanel(new java.awt.BorderLayout(0, 8));
            panel.add(new JLabel("Project root for this file:"), java.awt.BorderLayout.NORTH);
            panel.add(roots, java.awt.BorderLayout.CENTER); return panel;
        }
    }
}
