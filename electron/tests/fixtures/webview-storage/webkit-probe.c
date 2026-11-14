/*
 * WP-045 取证夹具：用与 wry 0.55.1 相同的 WebKitGTK 配置（WebsiteDataManager 的 base_data/base_cache
 * 都指向 Tauri 的 `app_local_data_dir`，`tauri` scheme 注册为 secure）在隔离目录里写入/读出
 * `tauri://localhost` 的 localStorage 与 IndexedDB，供迁移设计核对真实磁盘格式。
 *
 * 用法：webkit-probe <write|read> <data_directory>
 * 只在调用者给出的隔离目录内读写；不碰用户真实数据。stdout 输出一行 JSON（页面回报）。
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <webkit2/webkit2.h>

static const char *mode = NULL;
static int exit_code = 1;

static const char *PAGE =
  "<!doctype html><meta charset=utf-8><script>\n"
  "const post = (v) => window.webkit.messageHandlers.probe.postMessage(JSON.stringify(v));\n"
  "const mode = new URLSearchParams(location.search).get('mode');\n"
  "function idb() { return new Promise((res, rej) => { const r = indexedDB.open('wp045-probe', 1);\n"
  "  r.onupgradeneeded = () => r.result.createObjectStore('s');\n"
  "  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }\n"
  "function tx(db, m, f) { return new Promise((res, rej) => { const t = db.transaction('s', m); const out = f(t.objectStore('s'));\n"
  "  t.oncomplete = () => res(out.result); t.onerror = () => rej(t.error); }); }\n"
  "(async () => { try {\n"
  "  if (mode === 'write') {\n"
  "    const items = [['dstu-theme-mode','dark'], ['i18nextLng','zh-CN'], ['empty',''],\n"
  "      ['unicode','\\u4e2d\\u6587\\ud83d\\ude42'], ['nul','a\\u0000b'], ['lone','\\ud800x'],\n"
  "      ['json','{\"state\":{\"n\":1},\"version\":0}'], ['big','x'.repeat(70000)]];\n"
  "    for (const [k, v] of items) localStorage.setItem(k, v);\n"
  "    sessionStorage.setItem('session-only', '1');\n"
  "    const db = await idb();\n"
  "    await tx(db, 'readwrite', (s) => s.put({ d: new Date(0), u8: new Uint8Array([1,2,255]), m: new Map([['k',1]]) }, 'rec'));\n"
  "    db.close();\n"
  "    post({ ok: true, mode, origin: location.origin, href: location.href, isSecureContext, length: localStorage.length });\n"
  "  } else {\n"
  "    const all = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); all[k] = localStorage.getItem(k); }\n"
  "    const db = await idb(); const rec = await tx(db, 'readonly', (s) => s.get('rec')); db.close();\n"
  "    const big = all.big; delete all.big;\n"
  "    post({ ok: true, mode, origin: location.origin, localStorage: all, bigLength: big ? big.length : null,\n"
  "      nulCodes: all.nul ? [...all.nul].map((c) => c.charCodeAt(0)) : null,\n"
  "      loneCodes: all.lone ? [...all.lone].map((c) => c.charCodeAt(0)) : null,\n"
  "      session: sessionStorage.getItem('session-only'),\n"
  "      idb: rec ? { dateIsDate: rec.d instanceof Date, date: rec.d.toISOString(), u8: Array.from(rec.u8), u8Type: rec.u8.constructor.name, mapIsMap: rec.m instanceof Map } : null });\n"
  "  }\n"
  "} catch (e) { post({ ok: false, error: String(e) }); } })();\n"
  "</script>";

static void serve(WebKitURISchemeRequest *request, gpointer user_data) {
  (void)user_data;
  GInputStream *stream = g_memory_input_stream_new_from_data(PAGE, (gssize)strlen(PAGE), NULL);
  webkit_uri_scheme_request_finish(request, stream, (gint64)strlen(PAGE), "text/html");
  g_object_unref(stream);
}

static gboolean quit_later(gpointer data) {
  (void)data;
  gtk_main_quit();
  return G_SOURCE_REMOVE;
}

static void on_message(WebKitUserContentManager *manager, WebKitJavascriptResult *result, gpointer user_data) {
  (void)manager;
  (void)user_data;
  JSCValue *value = webkit_javascript_result_get_js_value(result);
  char *text = jsc_value_to_string(value);
  printf("%s\n", text);
  fflush(stdout);
  exit_code = strstr(text, "\"ok\":true") != NULL ? 0 : 2;
  g_free(text);
  /* 给 network process 留出把 localStorage/IndexedDB 落盘的时间，再正常退出主循环。 */
  g_timeout_add(3000, quit_later, NULL);
}

static gboolean timeout(gpointer data) {
  (void)data;
  fprintf(stderr, "probe timed out\n");
  exit_code = 3;
  gtk_main_quit();
  return G_SOURCE_REMOVE;
}

int main(int argc, char **argv) {
  if (argc != 3 || (strcmp(argv[1], "write") != 0 && strcmp(argv[1], "read") != 0)) {
    fprintf(stderr, "usage: webkit-probe <write|read> <data_directory>\n");
    return 64;
  }
  mode = argv[1];
  gtk_init(&argc, &argv);
  WebKitWebsiteDataManager *data = webkit_website_data_manager_new(
    "base-data-directory", argv[2], "base-cache-directory", argv[2], NULL);
  WebKitWebContext *context = webkit_web_context_new_with_website_data_manager(data);
  webkit_web_context_register_uri_scheme(context, "tauri", serve, NULL, NULL);
  webkit_security_manager_register_uri_scheme_as_secure(webkit_web_context_get_security_manager(context), "tauri");

  WebKitUserContentManager *ucm = webkit_user_content_manager_new();
  g_signal_connect(ucm, "script-message-received::probe", G_CALLBACK(on_message), NULL);
  webkit_user_content_manager_register_script_message_handler(ucm, "probe");
  GtkWidget *view = GTK_WIDGET(g_object_new(WEBKIT_TYPE_WEB_VIEW, "web-context", context, "user-content-manager", ucm, NULL));
  GtkWidget *window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
  gtk_container_add(GTK_CONTAINER(window), view);
  gtk_widget_show_all(window);

  char url[64];
  snprintf(url, sizeof url, "tauri://localhost/index.html?mode=%s", mode);
  webkit_web_view_load_uri(WEBKIT_WEB_VIEW(view), url);
  g_timeout_add_seconds(60, timeout, NULL);
  gtk_main();
  gtk_widget_destroy(window);
  g_object_unref(context);
  g_object_unref(data);
  return exit_code;
}
