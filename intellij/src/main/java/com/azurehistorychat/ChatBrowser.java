package com.azurehistorychat;

import com.google.gson.*;
import com.intellij.ide.util.PropertiesComponent;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.util.Disposer;
import com.intellij.ui.jcef.*;
import com.intellij.util.ui.UIUtil;
import org.cef.browser.CefBrowser;
import org.cef.browser.CefFrame;
import org.cef.handler.CefRequestHandlerAdapter;
import org.cef.handler.CefLifeSpanHandlerAdapter;
import org.cef.network.CefRequest;
import javax.swing.*;
import java.awt.Color;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.function.Consumer;

/** No credentials are exposed to Chromium; navigation and remote assets are disabled. */
final class ChatBrowser implements Disposable {
    private static final String PAGE = "http://azure-chat.local/index.html";
    private final JBCefBrowser browser = new JBCefBrowser();
    private final JBCefJSQuery query = JBCefJSQuery.create((JBCefBrowserBase) browser);
    private final ChatService service;
    private final Consumer<JsonObject> sink = this::post;
    private volatile boolean disposed;
    ChatBrowser(Project project) {
        service = ChatService.getInstance(project);
        Disposer.register(this, browser); Disposer.register(this, query);
        query.addHandler(request -> {
            if (disposed || !PAGE.equals(browser.getCefBrowser().getURL())) return null;
            try {
                JsonObject event = JsonParser.parseString(request).getAsJsonObject();
                if (Protocol.string(event, "type").equals("ui-state")) {
                    // UI state contains only draft/picker preferences, never the bearer token.
                    String value = Protocol.JSON.toJson(event.get("value"));
                    ApplicationManager.getApplication().invokeLater(() -> { if (!project.isDisposed()) PropertiesComponent.getInstance(project).setValue("azureChat.ui", value); });
                } else service.dispatch(event);
            } catch (RuntimeException ignored) {}
            return null;
        });
        browser.getJBCefClient().addRequestHandler(new CefRequestHandlerAdapter() {
            @Override public boolean onBeforeBrowse(CefBrowser browser, CefFrame frame, CefRequest request, boolean userGesture, boolean redirect) {
                return !PAGE.equals(request.getURL()) || redirect;
            }
            @Override public boolean onOpenURLFromTab(CefBrowser browser, CefFrame frame, String url, boolean userGesture) { return true; }
        }, browser.getCefBrowser());
        browser.getJBCefClient().addLifeSpanHandler(new CefLifeSpanHandlerAdapter() {
            @Override public boolean onBeforePopup(CefBrowser browser, CefFrame frame, String url, String name) { return true; }
        }, browser.getCefBrowser());
        service.bind(sink);
        try { browser.loadHTML(html(PropertiesComponent.getInstance(project).getValue("azureChat.ui", "{}")), PAGE); }
        catch (IOException error) { throw new IllegalStateException("Cannot load Azure Chat assets.", error); }
    }
    JComponent component() { return browser.getComponent(); }
    private void post(JsonObject event) {
        String json = Protocol.JSON.toJson(event).replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029");
        ApplicationManager.getApplication().invokeLater(() -> { if (!disposed) browser.getCefBrowser().executeJavaScript("window.dispatchEvent(new MessageEvent('message',{data:" + json + "}));", PAGE, 0); });
    }
    private static String resource(String name) throws IOException {
        try (InputStream input = ChatBrowser.class.getResourceAsStream("/web/" + name)) {
            if (input == null) throw new IOException("Missing resource " + name);
            return new String(input.readAllBytes(), StandardCharsets.UTF_8);
        }
    }
    private static String color(Color color) { return String.format("#%02x%02x%02x", color.getRed(), color.getGreen(), color.getBlue()); }
    private String html(String uiState) throws IOException {
        String nonce = UUID.randomUUID().toString().replace("-", "");
        String saved;
        try { saved = Protocol.JSON.toJson(JsonParser.parseString(uiState)); } catch (RuntimeException error) { saved = "{}"; }
        saved = saved.replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029");
        String bootstrap = "let uiState=" + saved + ";const nativeSend=(event)=>{" + query.inject("JSON.stringify(event)") + "};window.acquireVsCodeApi=()=>({postMessage:nativeSend,getState:()=>uiState,setState:value=>{uiState=value;nativeSend({type:'ui-state',value});}});document.addEventListener('click',event=>{const link=event.target.closest('a');if(link){event.preventDefault();nativeSend({type:'external',url:link.href});}},true);";
        boolean dark = Color.RGBtoHSB(UIUtil.getPanelBackground().getRed(), UIUtil.getPanelBackground().getGreen(), UIUtil.getPanelBackground().getBlue(), null)[2] < .6;
        String theme = "body{margin:0;background:" + color(UIUtil.getPanelBackground()) + ";--vscode-font-family:system-ui,sans-serif;--vscode-foreground:" + color(UIUtil.getLabelForeground()) + ";--vscode-input-foreground:var(--vscode-foreground);--vscode-input-background:" + color(UIUtil.getTextFieldBackground()) + ";--vscode-input-border:" + (dark ? "#555" : "#bbb") + ";--vscode-list-hoverBackground:" + (dark ? "#393b40" : "#e7e9ec") + ";--vscode-panel-border:" + (dark ? "#444" : "#ccc") + ";--vscode-descriptionForeground:" + (dark ? "#aaa" : "#666") + ";--vscode-button-background:#3574f0;--vscode-button-foreground:#fff;--vscode-focusBorder:#3574f0;--vscode-textCodeBlock-background:" + (dark ? "#23252a" : "#f2f3f5") + ";--vscode-editor-font-family:monospace;--vscode-editor-font-size:13px;--vscode-editor-foreground:var(--vscode-foreground);--vscode-textBlockQuote-border:#666;--vscode-textLink-foreground:#589df6}";
        StringBuilder html = new StringBuilder("<!DOCTYPE html><html><head><meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'nonce-" + nonce + "'; style-src 'nonce-" + nonce + "'; connect-src 'none'; img-src 'none'; form-action 'none'; base-uri 'none'\"><style nonce=\"" + nonce + "\">" + resource("chat.css") + theme + "</style></head><body class=\"" + (dark ? "vscode-dark" : "vscode-light") + "\">");
        html.append(resource("body.html"));
        for (String script : new String[]{bootstrap, resource("markdown-it.min.js"), resource("highlight.min.js"), resource("render-markdown.js"), resource("chat.js")}) html.append("<script nonce=\"").append(nonce).append("\">").append(script.replace("</script", "<\\/script")).append("</script>");
        return html.append("</body></html>").toString();
    }
    @Override public void dispose() { disposed = true; service.unbind(sink); }
}
