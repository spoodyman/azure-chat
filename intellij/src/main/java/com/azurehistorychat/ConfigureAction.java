package com.azurehistorychat;
import com.intellij.openapi.actionSystem.*;
import com.intellij.openapi.project.DumbAwareAction;
import org.jetbrains.annotations.NotNull;
public final class ConfigureAction extends DumbAwareAction {
    @Override public void actionPerformed(@NotNull AnActionEvent event) { if (event.getProject() != null) ChatService.getInstance(event.getProject()).configureConnection(); }
    @Override public void update(@NotNull AnActionEvent event) { event.getPresentation().setEnabled(event.getProject() != null); }
    @Override public @NotNull ActionUpdateThread getActionUpdateThread() { return ActionUpdateThread.BGT; }
}
