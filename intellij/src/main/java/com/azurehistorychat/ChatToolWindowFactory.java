package com.azurehistorychat;

import com.intellij.openapi.project.Project;
import com.intellij.openapi.wm.*;
import com.intellij.ui.content.ContentFactory;
import com.intellij.ui.jcef.JBCefApp;
import com.intellij.ui.components.JBLabel;
import org.jetbrains.annotations.NotNull;

public final class ChatToolWindowFactory implements ToolWindowFactory {
    @Override public void createToolWindowContent(@NotNull Project project, @NotNull ToolWindow window) {
        if (!JBCefApp.isSupported()) {
            window.getContentManager().addContent(ContentFactory.getInstance().createContent(new JBLabel("Azure Chat requires the IDE's bundled JetBrains Runtime with JCEF."), "", false));
            return;
        }
        ChatBrowser browser = new ChatBrowser(project);
        var content = ContentFactory.getInstance().createContent(browser.component(), "", false);
        content.setDisposer(browser);
        window.getContentManager().addContent(content);
    }
}
