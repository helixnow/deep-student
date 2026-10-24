// Run after Wry generation, before Kotlin snapshots its inputs for the build cache.
val prepareBilibiliRangeResponse = tasks.register("prepareBilibiliRangeResponse") {
    mustRunAfter(tasks.matching { it.name.startsWith("rustBuild") })
    doLast {
        val clients = fileTree("src/main/java") { include("**/RustWebViewClient.kt") }.files
        check(clients.size == 1) { "Expected one generated Wry WebView client" }
        val client = clients.single()
        val original = "val response = Rust.handleRequest(view.id, request, view.isDocumentStartScriptEnabled)"
        val adapted = "val response = BilibiliRangeResponse.adapt(request, Rust.handleRequest(view.id, request, view.isDocumentStartScriptEnabled))"
        val source = client.readText()
        if (!source.contains(adapted)) {
            check(source.split(original).size == 2) { "Wry WebView client changed; review the Bilibili Range adapter" }
            client.writeText(source.replace(original, adapted))
        }
    }
}
tasks.configureEach {
    if (name.startsWith("compile") && name.endsWith("Kotlin")) {
        dependsOn(prepareBilibiliRangeResponse)
    }
}
