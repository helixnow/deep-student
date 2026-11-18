package com.deepstudent.app;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.ClipData;
import android.content.pm.ProviderInfo;
import android.content.pm.PackageManager;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSArray;
import java.io.File;
import java.io.FileOutputStream;
import java.util.ArrayList;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.ImageDecoder;
import android.net.Uri;
import android.os.Build;
import android.provider.OpenableColumns;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

@CapacitorPlugin(name = "DeepStudentNative", permissions = {
    @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
})
public class DeepStudentNativePlugin extends Plugin {
    private static final int CHUNK_SIZE = 256 * 1024;
    private static final int MAX_CHUNK_TEXT = (CHUNK_SIZE + 2) / 3 * 4;
    private static final int MAX_HEIC_BYTES = 24 * 1024 * 1024;
    private static final long MAX_JPEG_PIXELS = 16_000_000;
    private static final String CHANNEL = "study-reminders";
    private static final String NOTIFICATION_ACTION = "com.deepstudent.app.NOTIFICATION_OPEN";
    private static final String NOTIFICATION_TARGET = "target";
    private static final AtomicInteger NEXT_NOTIFICATION = new AtomicInteger((int) (System.currentTimeMillis() & 0x3fffffff));
    private final Map<String, Closeable> documents = new ConcurrentHashMap<>();
    private final Map<String, Uri> pickedOutputs = new ConcurrentHashMap<>();
    private final Map<String, File> sharedOutputs = new ConcurrentHashMap<>();
    private android.content.SharedPreferences pendingShares() {
        return getContext().getSharedPreferences("pending-incoming-shares", Context.MODE_PRIVATE);
    }

    private File incomingFile(String id) {
        UUID.fromString(id);
        return new File(getContext().getNoBackupFilesDir(), "incoming-" + id);
    }

    private final AtomicBoolean pickerInProgress = new AtomicBoolean();

    @PluginMethod
    public void setImmersiveMode(PluginCall call) {
        Boolean enabled = call.getBoolean("enabled");
        if (enabled == null) {
            call.reject("enabled is required");
            return;
        }
        getActivity().runOnUiThread(() -> {
            ((MainActivity) getActivity()).setImmersiveMode(enabled);
            call.resolve();
        });
    }

    private String notificationPermission() {
        if (Build.VERSION.SDK_INT >= 33) {
            PermissionState state = getPermissionState("notifications");
            if (state == PermissionState.PROMPT || state == PermissionState.PROMPT_WITH_RATIONALE) return "prompt";
            if (state != PermissionState.GRANTED) return "denied";
        }
        return notificationsEnabled(getContext()) ? "granted" : "denied";
    }

    private static boolean notificationsEnabled(Context context) {
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = context.getSystemService(NotificationManager.class).getNotificationChannel(CHANNEL);
            if (channel != null && channel.getImportance() == NotificationManager.IMPORTANCE_NONE) return false;
        }
        return true;
    }

    @PluginMethod
    public void getNotificationPermission(PluginCall call) {
        call.resolve(new JSObject().put("state", notificationPermission()));
    }

    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && "prompt".equals(notificationPermission())) {
            requestPermissionForAlias("notifications", call, "notificationPermissionResult");
        } else {
            getNotificationPermission(call);
        }
    }

    @PermissionCallback
    private void notificationPermissionResult(PluginCall call) {
        String result = notificationPermission();
        // The current request was refused if Android permits prompting again.
        call.resolve(new JSObject().put("state", "prompt".equals(result) ? "denied" : result));
    }

    @PluginMethod
    public void postNotification(PluginCall call) {
        String title = call.getString("title");
        if (title == null || title.isEmpty()) {
            call.reject("Notification title is required");
            return;
        }
        String body = call.getString("body", "");
        String target = call.getString("target");
        long deadline = call.getLong("pomodoroDeadline", 0L);
        try {
            boolean posted = deadline > 0
                ? PomodoroAlarmReceiver.postOnce(getContext(), deadline, title, body)
                : sendNativeNotification(getContext(), title, body, target);
            call.resolve(new JSObject().put("posted", posted));
        } catch (SecurityException error) {
            call.reject("Android refused the notification", error);
        }
    }

    @PluginMethod
    public void setNotificationPolicy(PluginCall call) {
        String policy = call.getString("policy", "");
        if (!policy.equals("background") && !policy.equals("always") && !policy.equals("never")) {
            call.reject("Unknown notification policy");
            return;
        }
        PomodoroAlarmReceiver.setPolicy(getContext(), policy);
        call.resolve();
    }

    @PluginMethod
    public void setPomodoroAlarm(PluginCall call) {
        long deadline = call.getLong("deadline", 0L);
        String title = call.getString("title", "");
        String body = call.getString("body", "");
        if (deadline != 0 && (deadline < 0 || deadline > System.currentTimeMillis() + 86_400_000L ||
            title.isEmpty() || title.length() > 256 || body.length() > 1_024)) {
            call.reject("Invalid Pomodoro alarm");
            return;
        }
        try {
            PomodoroAlarmReceiver.schedule(getContext(), deadline, title, body);
            call.resolve();
        } catch (RuntimeException error) {
            call.reject("Android could not schedule the Pomodoro notification", error);
        }
    }

    static boolean sendNativeNotification(Context context, String title, String body, String target) {
        if (!notificationsEnabled(context)) return false;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        int id = NEXT_NOTIFICATION.incrementAndGet();
        Intent open = new Intent(context, MainActivity.class).setAction(NOTIFICATION_ACTION)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (isNotificationTarget(target)) open.putExtra(NOTIFICATION_TARGET, target);
        PendingIntent openApp = PendingIntent.getActivity(context, id, open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        if (Build.VERSION.SDK_INT >= 26) {
            String channelName = "zh".equals(java.util.Locale.getDefault().getLanguage()) ? "学习提醒" : "Study reminders";
            manager.createNotificationChannel(new NotificationChannel(CHANNEL, channelName, NotificationManager.IMPORTANCE_DEFAULT));
        }
        manager.notify(id, new NotificationCompat.Builder(context, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setCategory(NotificationCompat.CATEGORY_REMINDER)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setContentIntent(openApp)
                .setAutoCancel(true)
                .build());
        return true;
    }

    // The exported launcher accepts only the app's two existing notification navigation routes.
    private static boolean isNotificationTarget(String target) {
        return target != null && target.length() <= 256 &&
            (target.startsWith("todo:") || target.startsWith("review:"));
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        if (intent == null) return;
        if (receiveShare(intent)) return;
        if (!NOTIFICATION_ACTION.equals(intent.getAction())) return;
        String target = intent.getStringExtra(NOTIFICATION_TARGET);
        intent.removeExtra(NOTIFICATION_TARGET);
        if (isNotificationTarget(target)) notifyListeners("notificationAction", new JSObject().put("target", target), true);
    }

    // Activity instances can overlap while Android recreates the WebView.
    private static final Object SHARE_IO = new Object();
    private static final Object SHARE_GRANTS = new Object();

    @PluginMethod
    public void startShareListener(PluginCall call) {
        JSArray pending = new JSArray();
        synchronized (SHARE_IO) {
            try {
                java.util.Set<String> owned = new java.util.HashSet<>();
                for (Object raw : pendingShares().getAll().values()) {
                    JSObject share = new JSObject((String) raw);
                    if (share.optBoolean("finishing")) {
                        clearIncoming(share);
                        continue;
                    }
                    org.json.JSONArray files = share.optJSONArray("files");
                    if (files != null) for (int i = 0; i < files.length(); i++) {
                        String name = incomingFile(files.getJSONObject(i).getString("id")).getName();
                        owned.add(name);
                        owned.add(name + ".part");
                    }
                    pending.put(resumeIncoming(share));
                }
                File[] leftovers = getContext().getNoBackupFilesDir().listFiles();
                if (leftovers != null) for (File file : leftovers) {
                    if (file.getName().startsWith("incoming-") && !owned.contains(file.getName())) file.delete();
                }
                call.resolve(new JSObject().put("shares", pending));
            } catch (org.json.JSONException | IOException e) { call.reject("Unreadable pending share", e); }
        }
    }

    private void releaseShareGrants(JSObject share) throws org.json.JSONException {
        // A second share of the same URI may still need its package grant.
        org.json.JSONArray mine = share.optJSONArray("files");
        if (mine == null || !share.optBoolean("receiving")) return;
        java.util.Set<String> otherSources = new java.util.HashSet<>();
        for (Map.Entry<String, ?> entry : pendingShares().getAll().entrySet()) {
            if (entry.getKey().equals(share.getString("id"))) continue;
            org.json.JSONArray others = new JSObject((String) entry.getValue()).optJSONArray("files");
            if (others != null) for (int i = 0; i < others.length(); i++) {
                otherSources.add(others.getJSONObject(i).optString("uri"));
            }
        }
        for (int i = 0; i < mine.length(); i++) {
            String source = mine.getJSONObject(i).optString("uri");
            if (source.isEmpty() || otherSources.contains(source)) continue;
            Uri uri = Uri.parse(source);
            if (Build.VERSION.SDK_INT >= 26) {
                getContext().revokeUriPermission(getContext().getPackageName(), uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } else {
                getContext().revokeUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            }
        }
    }

    private boolean receiveShare(Intent intent) {
        if (intent == null) return false;
        boolean multi = Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction());
        if (!multi && !Intent.ACTION_SEND.equals(intent.getAction())) return false;
        String id = ((MainActivity) getActivity()).shareIdFor(intent);
        JSObject share = new JSObject().put("id", id).put("receivedAt", System.currentTimeMillis());
        CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        share.put("text", text == null ? "" : text.toString());
        java.util.LinkedHashSet<Uri> uris = new java.util.LinkedHashSet<>();
        if (multi) {
            ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) uris.addAll(list);
        } else uris.add(intent.getParcelableExtra(Intent.EXTRA_STREAM));
        ClipData clips = intent.getClipData();
        if (clips != null) for (int i = 0; i < clips.getItemCount(); i++) uris.add(clips.getItemAt(i).getUri());
        JSArray files = new JSArray();
        ArrayList<Uri> granted = new ArrayList<>();
        for (Uri uri : uris) {
            if (uri == null || !"content".equals(uri.getScheme()) || uri.getAuthority() == null) continue;
            ProviderInfo provider = getContext().getPackageManager().resolveContentProvider(uri.getAuthority(), 0);
            if (provider == null || provider.applicationInfo.uid == android.os.Process.myUid()) continue;
            if (getContext().checkUriPermission(uri, android.os.Process.myPid(), android.os.Process.myUid(),
                    Intent.FLAG_GRANT_READ_URI_PERMISSION) != PackageManager.PERMISSION_GRANTED) continue;
            granted.add(uri);
            files.put(new JSObject().put("id", UUID.randomUUID().toString()).put("uri", uri.toString()));
        }
        share.put("files", files).put("receiving", true);
        // An Activity grant can expire when the user reopens the launcher after process death.
        // Hold an explicit, read-only package grant for the duration of this import.
        synchronized (SHARE_GRANTS) {
            if (!pendingShares().contains(id)) {
                if (!pendingShares().edit().putString(id, share.toString()).commit()) {
                    notifyListeners("receivedShare", new JSObject().put("id", id).put("error", "storage"), true);
                    return true;
                }
                for (Uri uri : granted) {
                    try {
                        getContext().grantUriPermission(getContext().getPackageName(), uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    } catch (SecurityException e) {
                        android.util.Log.w("DeepStudent", "Share source did not allow retaining the read grant");
                    }
                }
            }
        }
        intent.setAction(null);
        bridge.execute(() -> {
            synchronized (SHARE_IO) {
                String raw = pendingShares().getString(id, null);
                if (raw == null) return;
                try { notifyListeners("receivedShare", resumeIncoming(new JSObject(raw)), true); }
                catch (org.json.JSONException e) { android.util.Log.e("DeepStudent", "Invalid pending share", e); }
            }
        });
        return true;
    }

    private JSObject resumeIncoming(JSObject share) throws org.json.JSONException {
        if (!share.optBoolean("receiving")) return share;
        String id = share.getString("id");
        JSArray ready = new JSArray();
        try {
            org.json.JSONArray sources = share.getJSONArray("files");
            for (int i = 0; i < sources.length(); i++) {
                org.json.JSONObject item = sources.getJSONObject(i);
                String fileId = item.getString("id");
                Uri uri = Uri.parse(item.getString("uri"));
                File target = incomingFile(fileId);
                String mime = item.optString("mime", null);
                if (mime == null) mime = getContext().getContentResolver().getType(uri);
                if (mime == null) throw new IOException("Missing shared file type");
                if (!(mime.startsWith("image/") || mime.equals("application/pdf"))) continue;
                if (!item.has("name")) {
                    item.put("name", documentName(uri)).put("mime", mime);
                    if (!pendingShares().edit().putString(id, share.toString()).commit()) throw new IOException("Cannot journal incoming file");
                }
                if (!target.isFile()) {
                    File part = new File(target.getPath() + ".part");
                    try (InputStream in = getContext().getContentResolver().openInputStream(uri);
                         FileOutputStream out = new FileOutputStream(part)) {
                        if (in == null) throw new IOException("Unreadable shared file");
                        byte[] buffer = new byte[64 * 1024];
                        int count;
                        while ((count = in.read(buffer)) != -1) out.write(buffer, 0, count);
                        out.getFD().sync();
                    }
                    if (!part.renameTo(target)) throw new IOException("Cannot finish incoming file");
                }
                ready.put(new JSObject().put("id", fileId).put("name", item.getString("name")).put("mime", mime));
            }
            JSObject result = new JSObject().put("id", id).put("receivedAt", share.getLong("receivedAt"))
                .put("text", share.optString("text")).put("files", ready);
            synchronized (SHARE_GRANTS) {
                releaseShareGrants(share);
                if (!pendingShares().edit().putString(id, result.toString()).commit()) throw new IOException("Cannot save share");
            }
            return result;
        } catch (IOException | RuntimeException e) {
            android.util.Log.w("DeepStudent", "Cannot resume pending share: " + e.getClass().getSimpleName());
            return new JSObject().put("id", id).put("receivedAt", share.getLong("receivedAt"))
                .put("error", "unreadable").put("canRetry", true);
        }
    }

    @PluginMethod
    public void retryIncomingShare(PluginCall call) {
        synchronized (SHARE_IO) {
            String raw = pendingShares().getString(call.getString("id", ""), null);
            if (raw == null) { call.reject("Unknown share"); return; }
            try { call.resolve(resumeIncoming(new JSObject(raw))); }
            catch (org.json.JSONException e) { call.reject("Invalid share", e); }
        }
    }

    @PluginMethod
    public void openIncomingFile(PluginCall call) {
        try {
            File local = incomingFile(call.getString("id", ""));
            String handle = UUID.randomUUID().toString();
            documents.put(handle, new java.io.FileInputStream(local));
            call.resolve(new JSObject().put("id", handle).put("size", local.length()));
        } catch (IOException | RuntimeException e) { call.reject("Unreadable shared file", e); }
    }

    @PluginMethod
    public void finishIncomingShare(PluginCall call) {
        String id = call.getString("id", "");
        synchronized (SHARE_IO) {
            String raw = pendingShares().getString(id, null);
            if (raw == null) { call.resolve(); return; }
            try {
                JSObject share = new JSObject(raw).put("finishing", true);
                if (!pendingShares().edit().putString(id, share.toString()).commit()) throw new IOException("Cannot acknowledge share");
                clearIncoming(share);
                call.resolve();
            } catch (Exception e) { call.reject("Unable to finish share", e); }
        }
    }

    private void clearIncoming(JSObject share) throws IOException, org.json.JSONException {
        org.json.JSONArray files = share.optJSONArray("files");
        if (files != null) for (int i = 0; i < files.length(); i++) {
            File file = incomingFile(files.getJSONObject(i).getString("id"));
            File part = new File(file.getPath() + ".part");
            if ((file.exists() && !file.delete()) || (part.exists() && !part.delete())) throw new IOException("Cannot clear incoming file");
        }
        synchronized (SHARE_GRANTS) {
            releaseShareGrants(share);
            if (!pendingShares().edit().remove(share.getString("id")).commit()) throw new IOException("Unable to dismiss share");
        }
    }

    @PluginMethod
    public void prepareExternalFile(PluginCall call) {
        String name = call.getString("name", "");
        if (name.isEmpty() || !new File(name).getName().equals(name) || name.equals(".") || name.equals("..")) { call.reject("Invalid file name"); return; }
        String id = UUID.randomUUID().toString();
        File folder = new File(getContext().getCacheDir(), "shared/" + id);
        if (!folder.mkdirs()) { call.reject("无法准备分享文件"); return; }
        File file = new File(folder, name);
        try {
            documents.put(id, new FileOutputStream(file));
            sharedOutputs.put(id, file);
            call.resolve(new JSObject().put("id", id));
        } catch (IOException e) { call.reject("无法准备分享文件", e); }
    }

    @PluginMethod
    public void openExternal(PluginCall call) {
        String id = call.getString("id", ""), mode = call.getString("mode", "");
        if (!(mode.equals("view") || mode.equals("share"))) { call.reject("Invalid action"); return; }
        try {
            Uri uri = pickedOutputs.get(id);
            if (uri == null) {
                File file = sharedOutputs.remove(id);
                if (file == null) { call.reject("文件已失效"); return; }
                uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
            }
            String mime = getContext().getContentResolver().getType(uri);
            if (mime == null) mime = "application/octet-stream";
            if (mode.equals("view")) {
                try {
                    getActivity().startActivity(new Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION));
                    call.resolve(new JSObject().put("action", "view")); return;
                } catch (android.content.ActivityNotFoundException ignored) { /* offer the system share sheet */ }
            }
            Intent share = new Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri);
            share.setClipData(ClipData.newRawUri("Deep Student", uri));
            share.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getActivity().startActivity(Intent.createChooser(share, null));
            call.resolve(new JSObject().put("action", "share"));
        } catch (RuntimeException e) { call.reject("无法用其他应用打开文件", e); }
    }

    @PluginMethod
    public void createDocument(PluginCall call) {
        String title = call.getString("fileName");
        String mime = call.getString("mimeType");
        if (title == null || title.isEmpty() || mime == null || !mime.matches("[a-zA-Z0-9!#$&^_.+-]+/[a-zA-Z0-9!#$&^_.+-]+")) {
            call.reject("A file name and MIME type are required");
            return;
        }
        launchPicker(call, new Intent(Intent.ACTION_CREATE_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType(mime)
            .putExtra(Intent.EXTRA_TITLE, title), "createdDocument");
    }

    @PluginMethod
    public void openDocument(PluginCall call) {
        // Some document providers label valid backups as application/octet-stream or give them no MIME type.
        launchPicker(call, new Intent(Intent.ACTION_OPEN_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType("*/*"), "openedDocument");
    }

    private void launchPicker(PluginCall call, Intent intent, String callbackName) {
        if (!pickerInProgress.compareAndSet(false, true)) {
            call.reject("Another Android file picker is open");
            return;
        }
        try {
            startActivityForResult(call, intent, callbackName);
        } catch (RuntimeException error) {
            pickerInProgress.set(false);
            call.reject("Unable to open the Android file picker", error);
        }
    }

    @ActivityCallback
    private void createdDocument(PluginCall call, ActivityResult result) {
        recordDocument(call, result, true);
    }

    @ActivityCallback
    private void openedDocument(PluginCall call, ActivityResult result) {
        recordDocument(call, result, false);
    }

    private void recordDocument(PluginCall call, ActivityResult result, boolean writing) {
        pickerInProgress.set(false);
        if (call == null) return;
        Uri uri = result.getData() == null ? null : result.getData().getData();
        if (result.getResultCode() != Activity.RESULT_OK || uri == null) {
            call.resolve(new JSObject().put("cancelled", true));
            return;
        }
        if (!"content".equals(uri.getScheme())) {
            call.reject("The file picker did not return a document URI");
            return;
        }
        // Opening a cloud-backed document may block. Capacitor serializes plugin calls on its plugin thread.
        getBridge().execute(() -> {
            try {
                String name = writing ? call.getString("fileName") : documentName(uri);
                Closeable stream = writing ? getContext().getContentResolver().openOutputStream(uri, "wt")
                    : getContext().getContentResolver().openInputStream(uri);
                if (stream == null) throw new IOException("Missing document stream");
                String id = UUID.randomUUID().toString();
                documents.put(id, stream);
                JSObject selected = new JSObject().put("id", id).put("name", name);
                if (writing) {
                    pickedOutputs.put(id, uri);
                    selected.put("path", "android-saf:" + id);
                }
                call.resolve(selected);
            } catch (IOException | RuntimeException error) {
                call.reject("Unable to open the selected document", error);
            }
        });
    }

    private String documentName(Uri uri) {
        try (Cursor cursor = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0)) return cursor.getString(0);
        } catch (RuntimeException ignored) {
            // The display name is optional; the document stream may still be readable.
        }
        return "deep-student-backup.zip";
    }

    @PluginMethod
    public void writeDocumentChunk(PluginCall call) {
        Closeable stream = documents.get(call.getString("id", ""));
        String data = call.getString("data");
        if (!(stream instanceof OutputStream) || data == null || data.length() > MAX_CHUNK_TEXT) {
            call.reject("Invalid document write");
            return;
        }
        try {
            byte[] bytes = Base64.decode(data, Base64.DEFAULT);
            if (bytes.length > CHUNK_SIZE) throw new IOException("Document chunk too large");
            ((OutputStream) stream).write(bytes);
            call.resolve();
        } catch (IOException | IllegalArgumentException error) {
            call.reject("Unable to write the selected document", error);
        }
    }

    @PluginMethod
    public void readDocumentChunk(PluginCall call) {
        Closeable stream = documents.get(call.getString("id", ""));
        if (!(stream instanceof InputStream)) {
            call.reject("Invalid document read");
            return;
        }
        try {
            byte[] bytes = new byte[CHUNK_SIZE];
            int length = ((InputStream) stream).read(bytes);
            if (length < 0) call.resolve(new JSObject().put("done", true));
            else if (length == 0) call.reject("Document stream did not return any bytes");
            else call.resolve(new JSObject().put("data", Base64.encodeToString(bytes, 0, length, Base64.NO_WRAP)));
        } catch (IOException error) {
            call.reject("Unable to read the selected document", error);
        }
    }

    @PluginMethod
    public void closeDocument(PluginCall call) {
        Closeable stream = documents.remove(call.getString("id", ""));
        try {
            if (stream != null) stream.close();
            call.resolve();
        } catch (IOException error) {
            call.reject("Unable to close the selected document", error);
        }
    }

    @PluginMethod
    public void decodeHeic(PluginCall call) {
        if (Build.VERSION.SDK_INT < 28) {
            call.reject("HEIC_UNSUPPORTED_OS: Android 9 or later is required");
            return;
        }
        String data = call.getString("data");
        if (data == null || data.isEmpty() || data.length() > (MAX_HEIC_BYTES + 2) / 3 * 4) {
            call.reject("HEIC attachment is empty or larger than 24 MiB");
            return;
        }
        try {
            byte[] bytes = Base64.decode(data, Base64.DEFAULT);
            if (bytes.length > MAX_HEIC_BYTES) throw new IOException("HEIC attachment is larger than 24 MiB");
            call.resolve(new JSObject().put("data", HeicDecoder.toJpeg(bytes)));
        } catch (IOException | RuntimeException error) {
            call.reject("Unable to decode HEIC on this device", error);
        }
    }

    @androidx.annotation.RequiresApi(28)
    private static class HeicDecoder {
        static String toJpeg(byte[] bytes) throws IOException {
            Bitmap bitmap = ImageDecoder.decodeBitmap(ImageDecoder.createSource(ByteBuffer.wrap(bytes)), (decoder, info, source) -> {
                decoder.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE);
                int width = info.getSize().getWidth();
                int height = info.getSize().getHeight();
                long pixels = (long) width * height;
                if (pixels > MAX_JPEG_PIXELS) {
                    double scale = Math.sqrt((double) MAX_JPEG_PIXELS / pixels);
                    decoder.setTargetSize(Math.max(1, (int) (width * scale)), Math.max(1, (int) (height * scale)));
                }
            });
            try (ByteArrayOutputStream jpeg = new ByteArrayOutputStream()) {
                if (!bitmap.compress(Bitmap.CompressFormat.JPEG, 90, jpeg)) throw new IOException("JPEG encoding failed");
                return Base64.encodeToString(jpeg.toByteArray(), Base64.NO_WRAP);
            } finally {
                bitmap.recycle();
            }
        }
    }

    @Override
    protected void handleOnDestroy() {
        for (Closeable stream : documents.values()) {
            try { stream.close(); } catch (IOException ignored) { }
        }
        documents.clear();
    }
}
