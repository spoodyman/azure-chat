plugins {
    java
    id("org.jetbrains.intellij.platform") version "2.19.0"
}

group = "com.azurehistorychat"
version = "0.1.7"

repositories {
    mavenCentral()
    intellijPlatform { defaultRepositories() }
}

dependencies {
    intellijPlatform {
        intellijIdeaCommunity("2024.3.6")
        pluginVerifier()
    }
    implementation("com.google.code.gson:gson:2.11.0")
    testImplementation("org.junit.jupiter:junit-jupiter:5.11.4")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
    // IntelliJ's test bootstrap references JUnit 4 even for Jupiter-only tests.
    testRuntimeOnly("junit:junit:4.13.2")
}

java {
    sourceCompatibility = JavaVersion.VERSION_21
    targetCompatibility = JavaVersion.VERSION_21
}
tasks.withType<JavaCompile>().configureEach { options.release.set(21) }
tasks.test { useJUnitPlatform() }
tasks.processResources {
    from("../media") {
        include("chat.js", "chat.css", "render-markdown.js", "code-cards.js", "code-instructions.txt", "markdown-it*", "highlight*", "icon.svg")
        into("web")
    }
}
intellijPlatform {
    pluginConfiguration {
        name = "Azure History Chat"
        ideaVersion {
            sinceBuild = "243"
            untilBuild = "261.*"
        }
    }
    buildSearchableOptions = false
    instrumentCode = false
    val verificationPlatform = providers.provider { platformPath.toFile() }
    pluginVerification { ides { local(verificationPlatform) } }
}
