package com.deepstudent.app;

import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.json.JSONObject;

@CapacitorPlugin(name = "LegacyData")
public class LegacyDataPlugin extends Plugin {
    private static final int CHUNK = 512 * 1024;
    private static final String[] DATABASES = {"chat_v2.db", "mistakes.db", "llm_usage.db", "databases/vfs.db"};
    private static final String[] ASSETS = {"images", "notes_assets", "documents", "vfs_blobs", "subjects",
        "workspaces", "audio", "videos", "textbooks", "pdf_ocr_sessions", "webview_settings.json", "custom_grading_modes.json"};
    private final Map<String, File> sources = new LinkedHashMap<>();
    private File cache;
    private String currentToken;

    @PluginMethod
    public synchronized void inspect(PluginCall call) {
        try {
            discardSnapshot();
            // The published Tauri Android build resolves its app data directory
            // to ApplicationInfo.dataDir, so its slots are siblings of files/.
            File root = new File(getContext().getApplicationInfo().dataDir).getCanonicalFile();
            File slot = findActiveSlot(root);
            if (slot == null) {
                root = getContext().getFilesDir().getCanonicalFile();
                slot = findActiveSlot(root);
            }
            if (slot == null) { call.resolve(new JSObject().put("available", false)); return; }

            currentToken = UUID.randomUUID().toString();
            cache = new File(getContext().getCacheDir(), "legacy-upgrade-" + currentToken);
            if (!cache.mkdir()) throw new IOException("Cannot create legacy database snapshot directory");
            JSArray descriptors = new JSArray();
            for (String relative : DATABASES) {
                File db = contained(root, new File(slot, relative));
                if (db.isFile()) addDatabase(root, db, db.getName(), "database", descriptors);
            }
            File browser = contained(root, new File(slot, "browser.db"));
            if (browser.isFile()) addDatabase(root, browser, "legacy/browser.db", "root", descriptors);
            File audit = contained(root, new File(slot, "databases/audit.db"));
            if (!audit.isFile()) audit = contained(root, new File(root, "databases/audit.db"));
            if (audit.isFile()) addDatabase(root, audit, "audit.db", "database", descriptors);
            for (String relative : ASSETS) addTree(root, new File(slot, relative), relative, "asset", descriptors);
            File master = new File(root, ".master_key");
            addTree(root, master.isFile() ? master : new File(slot, ".master_key"), ".master_key", "root", descriptors);
            // Mobile's secure store can open only the portable file seed. Keep a device-wrapped
            // seed and its ciphertext intact in the old native storage rather than breaking new settings.
            File secure = contained(root, new File(root, ".secure"));
            if (!secure.isDirectory()) secure = contained(root, new File(slot, ".secure"));
            File seed = contained(root, new File(secure, ".key_seed"));
            if (seed.isFile() && readText(seed).trim().matches("[a-fA-F0-9]{64}")) {
                addTree(root, secure, ".secure", "root", descriptors);
            }
            call.resolve(new JSObject().put("available", true).put("slot", slot.getName())
                .put("token", currentToken).put("files", descriptors));
        } catch (Exception e) {
            discardSnapshot();
            call.reject("Cannot read the previous Android data: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public synchronized void read(PluginCall call) {
        try {
            requireToken(call);
            File source = sources.get(call.getString("kind") + "/" + call.getString("name"));
            long offset = call.getData().optLong("offset", -1);
            int size = call.getData().optInt("length", -1);
            if (source == null || offset < 0 || size < 0 || size > CHUNK || offset > source.length() - size) {
                throw new IOException("Invalid legacy file read range");
            }
            byte[] bytes = new byte[size];
            try (RandomAccessFile file = new RandomAccessFile(source, "r")) {
                file.seek(offset);
                file.readFully(bytes);
            }
            call.resolve(new JSObject().put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP)));
        } catch (Exception e) {
            call.reject("Cannot read legacy data chunk: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public synchronized void close(PluginCall call) {
        try {
            requireToken(call);
            discardSnapshot();
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    private void requireToken(PluginCall call) throws IOException {
        if (currentToken == null || !currentToken.equals(call.getString("token"))) throw new IOException("Legacy snapshot is unavailable");
    }

    private void addDatabase(File root, File original, String name, String kind, JSArray entries) throws IOException {
        File snapshot = new File(cache, sources.size() + ".db");
        copy(original, snapshot);
        File wal = contained(root, new File(original.getPath() + "-wal"));
        if (wal.isFile() && wal.length() > 0) copy(wal, new File(snapshot.getPath() + "-wal"));
        try (SQLiteDatabase db = SQLiteDatabase.openDatabase(snapshot.getPath(), null,
            SQLiteDatabase.OPEN_READWRITE | SQLiteDatabase.NO_LOCALIZED_COLLATORS)) {
            try (Cursor checkpoint = db.rawQuery("PRAGMA wal_checkpoint(TRUNCATE)", null)) {
                if (!checkpoint.moveToFirst() || checkpoint.getInt(0) != 0) throw new IOException("Cannot checkpoint legacy " + name);
            }
            try (Cursor integrity = db.rawQuery("PRAGMA quick_check(1)", null)) {
                if (!integrity.moveToFirst() || !"ok".equals(integrity.getString(0))) throw new IOException("Invalid legacy database " + name);
            }
        }
        File pendingWal = new File(snapshot.getPath() + "-wal");
        if (pendingWal.isFile() && pendingWal.length() > 0) throw new IOException("Legacy database still has pending WAL data: " + name);
        addFile(snapshot, name, kind, entries);
    }

    private void addTree(File root, File path, String name, String kind, JSArray entries) throws IOException {
        File source = contained(root, path);
        if (source.isFile() && isAppleDouble(source)) return;
        if (source.isDirectory()) {
            File[] children = source.listFiles();
            if (children == null) throw new IOException("Cannot enumerate " + name);
            for (File child : children) addTree(root, child, name + "/" + child.getName(), kind, entries);
        } else if (source.isFile()) addFile(source, name, kind, entries);
    }

    private static boolean isAppleDouble(File source) throws IOException {
        if (!source.getName().startsWith("._") || source.length() < 4) return false;
        try (RandomAccessFile file = new RandomAccessFile(source, "r")) {
            return file.readInt() == 0x00051607;
        }
    }

    private void addFile(File source, String name, String kind, JSArray entries) {
        sources.put(kind + "/" + name, source);
        entries.put(new JSObject().put("name", name).put("kind", kind).put("size", source.length()));
    }

    private static File contained(File root, File child) throws IOException {
        File canonical = child.getCanonicalFile();
        if (!canonical.equals(child.getAbsoluteFile()) || !canonical.getPath().startsWith(root.getPath() + File.separator)) {
            throw new IOException("Unexpected legacy file location");
        }
        return canonical;
    }

    private static boolean hasDatabase(File slot) {
        for (String name : DATABASES) if (new File(slot, name).isFile()) return true;
        return false;
    }

    private static File findActiveSlot(File root) throws Exception {
        File state = contained(root, new File(root, "slots/state.json"));
        String active = state.isFile() ? new JSONObject(readText(state)).optString("active") : "";
        File a = contained(root, new File(root, "slots/slotA"));
        File b = contained(root, new File(root, "slots/slotB"));
        boolean hasA = hasDatabase(a);
        boolean hasB = hasDatabase(b);
        if ("slotA".equals(active) && hasA) return a;
        if ("slotB".equals(active) && hasB) return b;
        if (hasB && (!hasA || new File(b, "chat_v2.db").length() > new File(a, "chat_v2.db").length())) return b;
        return hasA ? a : null;
    }

    private static void copy(File source, File output) throws IOException {
        try (FileInputStream in = new FileInputStream(source); FileOutputStream out = new FileOutputStream(output)) {
            byte[] bytes = new byte[128 * 1024];
            for (int count; (count = in.read(bytes)) != -1;) out.write(bytes, 0, count);
        }
    }

    private static String readText(File source) throws IOException {
        if (source.length() > 64 * 1024) throw new IOException("Legacy metadata is too large");
        try (RandomAccessFile in = new RandomAccessFile(source, "r")) {
            byte[] bytes = new byte[(int) in.length()];
            in.readFully(bytes);
            return new String(bytes, StandardCharsets.UTF_8);
        }
    }

    private void discardSnapshot() {
        sources.clear();
        currentToken = null;
        if (cache == null) return;
        File[] snapshots = cache.listFiles();
        if (snapshots != null) for (File snapshot : snapshots) snapshot.delete();
        cache.delete();
        cache = null;
    }
}
