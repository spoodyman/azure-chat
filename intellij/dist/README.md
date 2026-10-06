# IntelliJ plugin distribution

`azure-history-chat-intellij-0.1.9.zip` is the installable Maven build, checked into Git so it is available after pushing this repository to GitHub. Install it through **Settings → Plugins → Install Plugin from Disk**.

The adjacent `.sha256` file records the archive's SHA-256 checksum. Verify it with `Get-FileHash -Algorithm SHA256` on Windows or `sha256sum -c azure-history-chat-intellij-0.1.9.zip.sha256` on Linux.

Validation: 34 Java tests passed; one symlink test was skipped because Windows symlink permissions were unavailable. JetBrains Plugin Verifier found the plugin compatible with IntelliJ IDEA 2024.3.6 (IC-243.26574.91), with two existing experimental project-trust API usages.

Build from the repository's `intellij` directory using `./mvnw clean verify` or `.\mvnw.cmd clean verify` with JDK 21 or newer. Copy the resulting versioned ZIP from `target/` here and regenerate the checksum when preparing a new distribution. Maven caches, verifier reports, and other build outputs remain ignored.
