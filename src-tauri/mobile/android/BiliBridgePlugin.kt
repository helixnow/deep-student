package com.deepstudent.app

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import app.tauri.plugin.JSObject

@InvokeArg
class BiliBridgeActiveArgs { var active: Boolean = false }

@TauriPlugin
class BiliBridgePlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun getActive(invoke: Invoke) {
    invoke.resolve(JSObject().put("active", BiliBridgeSessionService.active))
  }
  @Command
  fun setActive(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(BiliBridgeActiveArgs::class.java)
      val intent = Intent(activity, BiliBridgeSessionService::class.java)
      if (args.active) {
        if (Build.VERSION.SDK_INT >= 26) activity.startForegroundService(intent)
        else activity.startService(intent)
      } else activity.stopService(intent)
      invoke.resolve()
    } catch (error: Exception) { invoke.reject("Browser bridge foreground service unavailable") }
  }
}

class BiliBridgeSessionService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  private val stopIdle = Runnable { stopSelf() }
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == "com.deepstudent.app.BILI_BRIDGE_STOP") {
      stopSelf()
      return START_NOT_STICKY
    }
    val manager = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(
      NotificationChannel("bilibili_bridge", "Bilibili browser bridge", NotificationManager.IMPORTANCE_LOW)
    )
    val stop = Intent(this, BiliBridgeSessionService::class.java).setAction("com.deepstudent.app.BILI_BRIDGE_STOP")
    val cancel = PendingIntent.getService(this, 0, stop, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val open = PendingIntent.getActivity(this, 1, Intent(this, MainActivity::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, "bilibili_bridge") else Notification.Builder(this)
    val notification = builder.setSmallIcon(android.R.drawable.stat_sys_download)
      .setContentTitle("DeepStudent Bilibili")
      .setContentText("Browser bridge connected")
      .setContentIntent(open).setOngoing(true)
      .addAction(Notification.Action.Builder(null, "Disconnect", cancel).build()).build()
    if (Build.VERSION.SDK_INT >= 29) startForeground(4917, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    else startForeground(4917, notification)
    // Rust renews this lease during requests. No permanent silent background service.
    handler.removeCallbacks(stopIdle)
    handler.postDelayed(stopIdle, 120_000)
    active = true
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    active = false
    handler.removeCallbacks(stopIdle)
    super.onDestroy()
  }

  companion object { @Volatile var active: Boolean = false }
}
