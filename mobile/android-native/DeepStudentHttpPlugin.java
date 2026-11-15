package com.deepstudent.app;

import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.net.InetAddress;
import java.net.Proxy;
import java.net.UnknownHostException;
import java.util.Arrays;
import java.util.Collections;
import java.util.Iterator;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.ConnectionPool;
import okhttp3.Headers;
import okhttp3.HttpUrl;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okio.BufferedSink;

/** Executes one HTTP hop. The worker validates every DNS answer before handing us a pinned address. */
@CapacitorPlugin(name = "DeepStudentHttp")
public class DeepStudentHttpPlugin extends Plugin {
    private static final int CHUNK_SIZE = 64 * 1024;
    private final OkHttpClient standard = new OkHttpClient.Builder().followRedirects(false)
        .retryOnConnectionFailure(false).connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS).writeTimeout(0, TimeUnit.MILLISECONDS).build();
    private final ConcurrentHashMap<String, Pending> pending = new ConcurrentHashMap<>();

    private static final class Pending {
        final Call call;
        final Upload upload;
        volatile Response response;
        Pending(Call call, Upload upload) { this.call = call; this.upload = upload; }
        void close() {
            call.cancel();
            if (upload != null) upload.stop();
            if (response != null) response.close();
        }
    }

    /** Only one chunk is queued ahead of the network, so WebDAV need not load a whole archive in memory. */
    private static final class Upload extends RequestBody {
        private static final byte[] EOF = new byte[0];
        private final ArrayBlockingQueue<byte[]> chunks = new ArrayBlockingQueue<>(1);
        private final long length;
        private volatile boolean closed;
        Upload(long length) { this.length = length; }
        @Override public MediaType contentType() { return null; }
        @Override public long contentLength() { return length; }
        @Override public boolean isOneShot() { return true; }
        @Override public void writeTo(BufferedSink sink) throws IOException {
            try {
                while (!closed) {
                    byte[] bytes = chunks.take();
                    if (bytes == EOF && !closed) return;
                    if (!closed) sink.write(bytes);
                }
                throw new IOException("HTTP request canceled");
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                throw new IOException(error);
            } finally { stop(); }
        }
        void offer(byte[] bytes) throws IOException, InterruptedException {
            while (!closed) if (chunks.offer(bytes, 100, TimeUnit.MILLISECONDS)) return;
            throw new IOException("HTTP request canceled");
        }
        void stop() {
            closed = true;
            chunks.clear();
            chunks.offer(EOF);
        }
    }

    @PluginMethod
    public void resolve(PluginCall plugin) {
        String host = plugin.getString("host");
        if (host == null || host.isEmpty()) { plugin.reject("Host is required"); return; }
        standard.dispatcher().executorService().execute(() -> {
            try {
                JSArray addresses = new JSArray();
                for (InetAddress address : InetAddress.getAllByName(host)) addresses.put(address.getHostAddress());
                plugin.resolve(new JSObject().put("addresses", addresses));
            } catch (Exception error) { plugin.reject(error.getMessage(), error); }
        });
    }

    @PluginMethod
    public void open(PluginCall plugin) {
        String id = plugin.getString("id");
        String url = plugin.getString("url");
        if (id == null || url == null) { plugin.reject("HTTP request ID and URL are required"); return; }
        try {
            HttpUrl target = HttpUrl.get(url);
            String method = plugin.getString("method", "GET");
            Request.Builder request = new Request.Builder().url(target);
            JSObject headers = plugin.getObject("headers", new JSObject());
            for (Iterator<String> keys = headers.keys(); keys.hasNext();) {
                String key = keys.next();
                // Compute framing from the actual body and let OkHttp supply the validated request host.
                if (!key.equalsIgnoreCase("Content-Length") && !key.equalsIgnoreCase("Transfer-Encoding")
                    && !key.equalsIgnoreCase("Host") && !key.equalsIgnoreCase("Proxy-Authorization")) {
                    request.header(key, headers.getString(key));
                }
            }
            String body = plugin.getString("bodyBase64");
            byte[] bytes = body == null ? null : Base64.decode(body, Base64.NO_WRAP);
            boolean streaming = Boolean.TRUE.equals(plugin.getBoolean("uploadStream"));
            String contentLength = headers.getString("content-length", "-1");
            Upload upload = streaming ? new Upload(Long.parseLong(contentLength)) : null;
            if (bytes == null && Arrays.asList("POST", "PUT", "PATCH", "PROPPATCH", "REPORT").contains(method)) bytes = new byte[0];
            request.method(method, upload != null ? upload : bytes == null ? null : RequestBody.create(bytes, null));
            OkHttpClient client = standard;
            String pin = plugin.getString("addressBytes");
            if (pin != null) {
                // getByAddress uses raw numeric bytes and never performs DNS. A private per-call pool
                // prevents an existing connection from bypassing this request's validated address.
                InetAddress address = InetAddress.getByAddress(Base64.decode(pin, Base64.NO_WRAP));
                client = standard.newBuilder().proxy(Proxy.NO_PROXY)
                    .connectionPool(new ConnectionPool(0, 1, TimeUnit.SECONDS))
                    .dns(host -> {
                        if (!host.equals(target.host())) throw new UnknownHostException(host);
                        return Collections.singletonList(address);
                    }).build();
            }
            Call call = client.newCall(request.build());
            Integer timeout = plugin.getInt("timeoutMs");
            if (timeout != null && timeout > 0) call.timeout().timeout(timeout, TimeUnit.MILLISECONDS);
            Pending state = new Pending(call, upload);
            if (pending.putIfAbsent(id, state) != null) { plugin.reject("HTTP request ID already in use"); return; }
            call.enqueue(new Callback() {
                @Override public void onFailure(Call ignored, IOException error) {
                    pending.remove(id, state);
                    if (upload != null) upload.stop();
                    plugin.reject(error.getMessage(), error);
                }
                @Override public void onResponse(Call ignored, Response response) {
                    state.response = response;
                    if (pending.get(id) != state) {
                        response.close();
                        plugin.reject("HTTP request canceled");
                        return;
                    }
                    JSObject responseHeaders = new JSObject();
                    Headers values = response.headers();
                    for (String name : values.names()) responseHeaders.put(name, String.join(", ", values.values(name)));
                    plugin.resolve(new JSObject().put("status", response.code()).put("statusText", response.message())
                        .put("headers", responseHeaders).put("url", response.request().url().toString()));
                }
            });
        } catch (Exception error) { plugin.reject(error.getMessage(), error); }
    }

    @PluginMethod
    public void write(PluginCall plugin) {
        Pending state = pending.get(plugin.getString("id", ""));
        if (state == null || state.upload == null) { plugin.reject("HTTP request body is closed"); return; }
        String data = plugin.getString("bodyBase64");
        standard.dispatcher().executorService().execute(() -> {
            try {
                state.upload.offer(data == null ? Upload.EOF : Base64.decode(data, Base64.NO_WRAP));
                plugin.resolve();
            } catch (Exception error) { plugin.reject(error.getMessage(), error); }
        });
    }

    @PluginMethod
    public void read(PluginCall plugin) {
        String id = plugin.getString("id", "");
        Pending state = pending.get(id);
        if (state == null || state.response == null) { plugin.reject("HTTP response is closed"); return; }
        standard.dispatcher().executorService().execute(() -> {
            try {
                byte[] buf = new byte[CHUNK_SIZE];
                int n = state.response.body() == null ? -1 : state.response.body().byteStream().read(buf);
                if (n < 0) {
                    pending.remove(id, state);
                    state.response.close();
                    plugin.resolve(new JSObject().put("done", true));
                } else plugin.resolve(new JSObject().put("done", false).put("bodyBase64", Base64.encodeToString(buf, 0, n, Base64.NO_WRAP)));
            } catch (Exception error) {
                pending.remove(id, state);
                state.close();
                plugin.reject(error.getMessage(), error);
            }
        });
    }

    @PluginMethod
    public void cancel(PluginCall plugin) {
        Pending state = pending.remove(plugin.getString("id", ""));
        if (state != null) standard.dispatcher().executorService().execute(state::close);
        plugin.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        for (Pending state : pending.values()) state.close();
        pending.clear();
    }
}
