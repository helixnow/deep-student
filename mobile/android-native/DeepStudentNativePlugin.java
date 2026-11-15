package com.deepstudent.app;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
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
        if (intent == null || !NOTIFICATION_ACTION.equals(intent.getAction())) return;
        String target = intent.getStringExtra(NOTIFICATION_TARGET);
        intent.removeExtra(NOTIFICATION_TARGET);
        if (isNotificationTarget(target)) notifyListeners("notificationAction", new JSObject().put("target", target), true);
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
                call.resolve(new JSObject().put("id", id).put("name", name));
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
