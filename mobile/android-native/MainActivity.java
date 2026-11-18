package com.deepstudent.app;

import android.os.Bundle;
import androidx.activity.OnBackPressedCallback;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final String UI_PREFERENCES = "deep_student_native_ui";
    private static final String IMMERSIVE = "immersive";
    static volatile boolean inForeground;
    private boolean launchedFromShare;
    private String launchShareId;

    String shareIdFor(android.content.Intent intent) {
        if (intent == getIntent() && launchedFromShare) return launchShareId;
        return java.util.UUID.randomUUID().toString();
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        String action = getIntent().getAction();
        launchedFromShare = android.content.Intent.ACTION_SEND.equals(action) || android.content.Intent.ACTION_SEND_MULTIPLE.equals(action);
        if (launchedFromShare) {
            launchShareId = savedInstanceState == null ? null : savedInstanceState.getString("launchShareId");
            if (launchShareId == null) launchShareId = java.util.UUID.randomUUID().toString();
        }
        if (launchedFromShare && savedInstanceState != null && savedInstanceState.getBoolean("deliveredShare")) {
            getIntent().setAction(null);
        }
        registerPlugin(DeepStudentNativePlugin.class);
        registerPlugin(DeepStudentHttpPlugin.class);
        registerPlugin(LegacyDataPlugin.class);
        super.onCreate(savedInstanceState);
        if (getPreferencesValue()) applyImmersiveMode(true);
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                getBridge().getWebView().evaluateJavascript(
                    "Boolean(window.__DEEP_STUDENT_HANDLE_BACK__?.())",
                    handled -> {
                        if ("false".equals(handled)) moveTaskToBack(true);
                    }
                );
            }
        });
    }

    @Override
    public void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state);
        state.putString("launchShareId", launchShareId);
        state.putBoolean("deliveredShare", launchedFromShare && getIntent().getAction() == null);
    }

    @Override
    public void onResume() {
        super.onResume();
        inForeground = true;
    }

    @Override
    public void onPause() {
        inForeground = false;
        super.onPause();
    }

    private boolean getPreferencesValue() {
        return getSharedPreferences(UI_PREFERENCES, MODE_PRIVATE).getBoolean(IMMERSIVE, false);
    }

    void setImmersiveMode(boolean enabled) {
        applyImmersiveMode(enabled);
        getSharedPreferences(UI_PREFERENCES, MODE_PRIVATE).edit().putBoolean(IMMERSIVE, enabled).apply();
    }

    private void applyImmersiveMode(boolean enabled) {
        WindowInsetsControllerCompat controls = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        if (enabled) {
            controls.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            controls.hide(WindowInsetsCompat.Type.systemBars());
        } else {
            controls.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_DEFAULT);
            controls.show(WindowInsetsCompat.Type.systemBars());
        }
    }
}
