package com.azurehistorychat;

import com.intellij.openapi.ui.DialogWrapper;
import com.intellij.openapi.ui.ValidationInfo;
import com.intellij.openapi.project.Project;
import com.intellij.ui.components.JBTextField;
import org.jetbrains.annotations.Nullable;
import javax.swing.*;
import java.awt.*;

final class ConnectionDialog extends DialogWrapper {
    private final JBTextField url = new JBTextField();
    private final JPasswordField token = new JPasswordField();
    private final JComboBox<String> readMethod = new JComboBox<>(new String[]{"GET", "POST"});
    private final JSpinner limit = new JSpinner(new SpinnerNumberModel(200000, 1024, 100000000, 1024));
    private final JCheckBox proposals = new JCheckBox("Append file proposal formatting instructions");
    private final JCheckBox logging = new JCheckBox("Log API calls (includes chat and attached text)");
    ConnectionDialog(Project project, ChatSettings.Data settings) {
        super(project);
        setTitle("Azure Chat Connection");
        url.setText(settings.baseUrl); readMethod.setSelectedItem(settings.historyReadMethod);
        limit.setValue(Math.max(1024, Math.min(100000000, settings.maxAttachmentBytes)));
        proposals.setSelected(settings.fileProposalInstructions); logging.setSelected(settings.logApiCalls);
        init();
    }
    @Override protected @Nullable JComponent createCenterPanel() {
        JPanel panel = new JPanel(new GridLayout(0, 1, 0, 5));
        panel.setPreferredSize(new Dimension(520, 320));
        panel.add(new JLabel("Chat application base URL (https://your-chat-app.azurewebsites.net)")); panel.add(url);
        panel.add(new JLabel("User bearer token (leave empty to keep token for this URL)")); panel.add(token);
        panel.add(new JLabel("History read route (POST for the Microsoft sample)")); panel.add(readMethod);
        panel.add(new JLabel("Combined attachment and skills byte limit")); panel.add(limit);
        panel.add(proposals); panel.add(logging);
        return panel;
    }
    @Override protected @Nullable ValidationInfo doValidate() {
        try { AzureClient.validateUrl(url.getText()); return null; }
        catch (RuntimeException error) { return new ValidationInfo(error.getMessage(), url); }
    }
    String url() { return AzureClient.validateUrl(url.getText()); }
    String token() { char[] value = token.getPassword(); try { return new String(value).trim().replaceFirst("(?i)^Bearer\\s+", ""); } finally { java.util.Arrays.fill(value, '\0'); token.setText(""); } }
    String readMethod() { return (String) readMethod.getSelectedItem(); }
    int limit() { return (Integer) limit.getValue(); }
    boolean proposals() { return proposals.isSelected(); }
    boolean logging() { return logging.isSelected(); }
}
