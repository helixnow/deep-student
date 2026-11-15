package com.deepstudent.app;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.util.Log;

/** One native notification for the countdown already owned by the WebView timer. */
public class PomodoroAlarmReceiver extends BroadcastReceiver {
    private static final String PREFS = "deep_student_pomodoro_alarm";
    private static final String DEADLINE = "active_deadline";
    private static final String DELIVERED = "delivered_deadline";
    private static final String POLICY = "notification_policy";

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static synchronized void setPolicy(Context context, String policy) {
        prefs(context).edit().putString(POLICY, policy).apply();
    }

    static synchronized void schedule(Context context, long deadline, String title, String body) {
        Intent intent = new Intent(context, PomodoroAlarmReceiver.class);
        AlarmManager alarms = context.getSystemService(AlarmManager.class);
        if (deadline == 0) {
            prefs(context).edit().remove(DEADLINE).apply();
            PendingIntent existing = PendingIntent.getBroadcast(context, 0, intent,
                PendingIntent.FLAG_NO_CREATE | PendingIntent.FLAG_IMMUTABLE);
            if (existing != null) {
                alarms.cancel(existing);
                existing.cancel();
            }
            return;
        }
        if (deadline <= System.currentTimeMillis()) return;
        intent.putExtra(DEADLINE, deadline).putExtra("title", title).putExtra("body", body);
        PendingIntent pending = PendingIntent.getBroadcast(context, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, deadline, pending);
        prefs(context).edit().putLong(DEADLINE, deadline).apply();
    }

    static synchronized boolean postOnce(Context context, long deadline, String title, String body) {
        SharedPreferences prefs = prefs(context);
        if (prefs.getLong(DELIVERED, 0) == deadline) return true;
        if (!DeepStudentNativePlugin.sendNativeNotification(context, title, body, null)) return false;
        prefs.edit().putLong(DELIVERED, deadline).apply();
        return true;
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        synchronized (PomodoroAlarmReceiver.class) {
            long deadline = intent.getLongExtra(DEADLINE, 0);
            SharedPreferences prefs = prefs(context);
            if (deadline == 0 || deadline != prefs.getLong(DEADLINE, 0) || deadline > System.currentTimeMillis()) return;
            prefs.edit().remove(DEADLINE).apply();
            String policy = prefs.getString(POLICY, "background");
            if ("never".equals(policy) || ("background".equals(policy) && MainActivity.inForeground)) return;
            try {
                postOnce(context, deadline, intent.getStringExtra("title"), intent.getStringExtra("body"));
            } catch (SecurityException error) {
                Log.w("PomodoroAlarm", "Android refused the notification", error);
            }
        }
    }
}
