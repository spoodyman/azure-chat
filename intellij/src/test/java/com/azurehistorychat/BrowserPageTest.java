package com.azurehistorychat;

import org.junit.jupiter.api.Test;
import java.net.*;
import java.nio.file.*;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class BrowserPageTest {
    @Test void actualJcefHtmlLoaderPreservesTheAddressUsedByNavigationAndNativeBridge() throws Exception {
        Path ide = Path.of(System.getProperty("idea.home"));
        List<URL> jars = new ArrayList<>();
        for (String directory : List.of("lib", "plugins/jcef-plugin/lib", "jbr/lib", "jbr/Contents/Home/lib")) {
            Path folder = ide.resolve(directory);
            if (!Files.isDirectory(folder)) continue;
            try (var files = Files.walk(folder)) {
                for (Path file : files.filter(path -> path.toString().endsWith(".jar")).toList()) jars.add(file.toUri().toURL());
            }
        }
        // Isolate the SDK without starting an IDE, JCEF native process, or platform test bootstrap.
        try (var sdk = new URLClassLoader(jars.toArray(URL[]::new), ClassLoader.getPlatformClassLoader())) {
            var factory = sdk.loadClass("com.intellij.ui.jcef.JBCefFileSchemeHandlerFactory");
            var makeUrl = factory.getMethod("makeFileUrl", String.class);
            String loaded = (String) makeUrl.invoke(null, BrowserPage.URL);
            assertEquals(BrowserPage.URL, loaded, "The loader must retain the URL accepted by navigation and JS bridge checks.");
            assertEquals("file", URI.create(loaded).getScheme());
            assertNotEquals("http://azure-chat.local/index.html", makeUrl.invoke(null, "http://azure-chat.local/index.html"), "The previous HTTP address is rewritten by JCEF and cannot be matched literally.");
        }
    }
}
