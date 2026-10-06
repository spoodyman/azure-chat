# IntelliJ plugin distribution

`azure-history-chat-intellij-0.1.11.zip` is the current installable Maven build, checked into Git so it is available after pushing this repository to GitHub. It supports builds 243–262, including IntelliJ IDEA 2026.2.3 (`IU-262.10968.63`). Install it through **Settings → Plugins → Install Plugin from Disk**. Older distributions remain available with their original compatibility ranges.

The adjacent `.sha256` file records the archive's SHA-256 checksum. Verify it with `Get-FileHash -Algorithm SHA256` on Windows or `sha256sum -c azure-history-chat-intellij-0.1.11.zip.sha256` on Linux.

Validation: 34 Java tests passed; one symlink test was skipped because Windows symlink permissions were unavailable. The build succeeded with a fresh Maven Central cache using the installed `IU-262.10968.63` SDK and JDK 25, then packaged successfully with Maven offline. No IntelliJ platform artifacts or JetBrains Maven repositories were used. Plugin Verifier 1.410 found version 0.1.11 compatible with `IU-262.10968.63` and `IC-243.26574.91`; the former reports four deprecated API usages and two experimental API usages, without compatibility errors. Binary compatibility verification does not cover an interactive session with a live Azure backend.

Build from the repository's `intellij` directory using `.\mvnw.cmd "-Didea.home=C:\path\to\IntelliJ IDEA" clean verify` (or `./mvnw` on Unix). Use JDK 25 for an IntelliJ 262 SDK; see the [local SDK setup](../README.md#diagnostics-and-development). Copy the resulting versioned ZIP from `target/` here and regenerate the checksum when preparing a new distribution. Maven caches, verifier reports, and other build outputs remain ignored.
