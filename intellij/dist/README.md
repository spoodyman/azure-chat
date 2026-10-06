# IntelliJ plugin distribution

`azure-history-chat-intellij-0.1.10.zip` is the current installable Maven build, checked into Git so it is available after pushing this repository to GitHub. It supports builds 243–262, including IntelliJ IDEA 2026.2.3 (`IU-262.10968.63`). Install it through **Settings → Plugins → Install Plugin from Disk**. Version 0.1.9 remains available for its original builds 243–261.

The adjacent `.sha256` file records the archive's SHA-256 checksum. Verify it with `Get-FileHash -Algorithm SHA256` on Windows or `sha256sum -c azure-history-chat-intellij-0.1.10.zip.sha256` on Linux.

Validation: 34 Java tests passed; one symlink test was skipped because Windows symlink permissions were unavailable. JetBrains Plugin Verifier 1.410 found version 0.1.10 compatible with both `IU-262.10968.63` and `IC-243.26574.91`. Build 262 reports four deprecated API usages and two experimental project-trust API usages, with no compatibility errors or plugin configuration defects. Binary compatibility verification does not cover an interactive session with a live Azure backend.

Build from the repository's `intellij` directory using `./mvnw clean verify` or `.\mvnw.cmd clean verify` with JDK 21 or newer. Copy the resulting versioned ZIP from `target/` here and regenerate the checksum when preparing a new distribution. Maven caches, verifier reports, and other build outputs remain ignored.
