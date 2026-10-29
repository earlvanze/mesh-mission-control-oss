package io.github.earlvanze.meshmission;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.os.Bundle;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.regex.Pattern;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;
import org.json.JSONArray;
import org.json.JSONObject;

/** Hosts the dashboard page and gives it a narrow, certificate-pinned channel to the user's own bridge server. */
public class MainActivity extends Activity {
  private static final int PORT = 18877;
  private static final int MAX_RESPONSE = 4000000;
  private static final Pattern ADDRESS = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$");
  private WebView view;
  private SharedPreferences prefs;

  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    prefs = getSharedPreferences("mesh", Context.MODE_PRIVATE);
    view = new WebView(this);
    WebSettings s = view.getSettings();
    s.setJavaScriptEnabled(true);
    s.setAllowFileAccess(true);
    s.setAllowFileAccessFromFileURLs(true);
    s.setAllowUniversalAccessFromFileURLs(false);
    view.addJavascriptInterface(new Bridge(), "MeshBridge");
    view.setWebViewClient(new WebViewClient() {
      @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) { return true; }
    });
    edgeInsets();
    view.loadUrl("file:///android_asset/index.html");
  }

  /** Targeting Android 15 draws under the status bar and cutouts; pad the page so the header clears them. */
  @SuppressWarnings("deprecation")
  private void edgeInsets() {
    android.widget.FrameLayout frame = new android.widget.FrameLayout(this);
    frame.setBackgroundColor(0xFF090F18);
    frame.addView(view, new android.widget.FrameLayout.LayoutParams(-1, -1));
    setContentView(frame);
    frame.setOnApplyWindowInsetsListener((v, insets) -> {
      int top = insets.getSystemWindowInsetTop();
      if (android.os.Build.VERSION.SDK_INT >= 28 && insets.getDisplayCutout() != null) top = Math.max(top, insets.getDisplayCutout().getSafeInsetTop());
      v.setPadding(insets.getSystemWindowInsetLeft(), top, insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
      return insets;
    });
    frame.requestApplyInsets();
  }

  @Override protected void onResume() {
    super.onResume();
    if (view != null) view.evaluateJavascript("window.meshResume && window.meshResume()", null);
  }

  /** Accepts any certificate but records it, so the user can confirm its fingerprint. Never used with the token. */
  static class Recorder implements X509TrustManager {
    String fingerprint = "";
    public void checkClientTrusted(X509Certificate[] c, String a) {}
    public void checkServerTrusted(X509Certificate[] c, String a) { fingerprint = fingerprint(c[0]); }
    public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
  }

  /** Trusts exactly one certificate, identified by its SHA-256 fingerprint. */
  static class Pinned implements X509TrustManager {
    final String expected;
    Pinned(String expected) { this.expected = expected; }
    public void checkClientTrusted(X509Certificate[] c, String a) throws java.security.cert.CertificateException { throw new java.security.cert.CertificateException(); }
    public void checkServerTrusted(X509Certificate[] c, String a) throws java.security.cert.CertificateException {
      if (c == null || c.length == 0 || !fingerprint(c[0]).equalsIgnoreCase(expected)) throw new java.security.cert.CertificateException("Certificate does not match the pinned fingerprint");
    }
    public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
  }

  static String fingerprint(X509Certificate cert) {
    try {
      byte[] digest = MessageDigest.getInstance("SHA-256").digest(cert.getEncoded());
      StringBuilder out = new StringBuilder();
      for (int i = 0; i < digest.length; i++) { if (i > 0) out.append(':'); out.append(String.format("%02X", digest[i] & 0xff)); }
      return out.toString();
    } catch (Exception e) { return ""; }
  }

  static HttpsURLConnection open(String address, String path, TrustManager trust, int connectMs, int readMs) throws Exception {
    SSLContext ctx = SSLContext.getInstance("TLS");
    ctx.init(null, new TrustManager[] {trust}, new SecureRandom());
    HttpsURLConnection c = (HttpsURLConnection) new URL("https://" + address + path).openConnection();
    c.setSSLSocketFactory(ctx.getSocketFactory());
    c.setHostnameVerifier((host, session) -> true); // identity is the pinned fingerprint, not the name
    c.setConnectTimeout(connectMs);
    c.setReadTimeout(readMs);
    return c;
  }

  static byte[] readLimited(InputStream in) throws Exception {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    byte[] b = new byte[8192]; int n;
    while ((n = in.read(b)) != -1) { if (out.size() + n > MAX_RESPONSE) throw new Exception("Response too large"); out.write(b, 0, n); }
    return out.toByteArray();
  }

  /** "host", "host:port" or "https://host:port" to "host:port"; null when it is not a plain address. */
  static String normalize(String raw) {
    String s = raw == null ? "" : raw.trim();
    if (s.startsWith("https://")) s = s.substring(8);
    if (s.endsWith("/")) s = s.substring(0, s.length() - 1);
    String host = s; int port = PORT;
    int colon = s.lastIndexOf(':');
    if (colon > 0) { host = s.substring(0, colon); try { port = Integer.parseInt(s.substring(colon + 1)); } catch (NumberFormatException e) { return null; } }
    if (!ADDRESS.matcher(host).matches() || port < 1 || port > 65535) return null;
    return host + ":" + port;
  }

  class Bridge {
    private final ExecutorService scanPool = Executors.newFixedThreadPool(48);

    private void deliver(int id, int status, byte[] body) {
      final String data = Base64.encodeToString(body, Base64.NO_WRAP);
      runOnUiThread(() -> {
        view.evaluateJavascript("window.__mc=''", null);
        for (int i = 0; i < data.length(); i += 100000)
          view.evaluateJavascript("window.__mc+='" + data.substring(i, Math.min(data.length(), i + 100000)) + "'", null);
        view.evaluateJavascript("window.meshNative(" + id + "," + status + ",window.__mc);window.__mc=''", null);
      });
    }
    private void deliver(int id, int status, JSONObject json) { deliver(id, status, json.toString().getBytes(StandardCharsets.UTF_8)); }

    @JavascriptInterface public String config() {
      try {
        JSONObject o = new JSONObject();
        o.put("server", prefs.getString("server", ""));
        o.put("fingerprint", prefs.getString("fingerprint", ""));
        o.put("paired", !prefs.getString("token", "").isEmpty() && !prefs.getString("fingerprint", "").isEmpty());
        return o.toString();
      } catch (Exception e) { return "{}"; }
    }

    /** Reads the server's certificate and hello so the user can compare the fingerprint. Sends no credentials. */
    @JavascriptInterface public void inspect(int id, String server) {
      new Thread(() -> {
        try {
          String address = normalize(server);
          if (address == null) throw new Exception("Invalid address");
          JSONObject out = hello(address, 4000);
          deliver(id, 200, out);
        } catch (Exception e) { deliver(id, 502, new JSONObject()); }
      }).start();
    }

    private JSONObject hello(String address, int connectMs) throws Exception {
      Recorder recorder = new Recorder();
      HttpsURLConnection c = open(address, "/api/hello", recorder, connectMs, 4000);
      try {
        JSONObject hello = new JSONObject(new String(readLimited(c.getInputStream()), StandardCharsets.UTF_8));
        if (!"mesh-mission-control".equals(hello.optString("app"))) throw new Exception("Not a Mesh Mission Control server");
        JSONObject out = new JSONObject();
        out.put("name", hello.optString("name"));
        out.put("address", address);
        out.put("fingerprint", recorder.fingerprint); // the certificate actually presented, not the claimed one
        return out;
      } finally { c.disconnect(); }
    }

    @JavascriptInterface public void save(int id, String server, String token, String fingerprint) {
      new Thread(() -> {
        try {
          String address = normalize(server);
          String old = prefs.getString("token", "");
          String secret = token == null ? "" : token.trim();
          if (secret.isEmpty()) secret = old;
          if (address == null) throw new Exception("Invalid address");
          if (secret.isEmpty() || secret.length() > 256 || !secret.matches("[A-Za-z0-9_-]+")) throw new Exception("Enter the token printed by mmc.py pair");
          if (fingerprint == null || !fingerprint.matches("([0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}")) throw new Exception("Invalid fingerprint");
          // Confirm the token works against the pinned certificate before keeping anything.
          HttpsURLConnection c = open(address, "/api/hosts", new Pinned(fingerprint), 5000, 15000);
          c.setRequestProperty("Authorization", "Bearer " + secret);
          int code = c.getResponseCode(); c.disconnect();
          if (code == 403) throw new Exception("The server rejected that token");
          if (code != 200) throw new Exception("Unexpected response " + code);
          prefs.edit().putString("server", address).putString("token", secret).putString("fingerprint", fingerprint.toUpperCase()).apply();
          deliver(id, 200, new JSONObject().put("ok", true));
        } catch (Exception e) {
          try { deliver(id, 400, new JSONObject().put("ok", false).put("error", String.valueOf(e.getMessage()))); } catch (Exception x) { deliver(id, 400, new JSONObject()); }
        }
      }).start();
    }

    /** Authenticated request to the paired server; refuses any certificate but the pinned one. */
    @JavascriptInterface public void request(int id, String method, String path, String body) {
      new Thread(() -> {
        try {
          String server = prefs.getString("server", ""), token = prefs.getString("token", ""), fp = prefs.getString("fingerprint", "");
          if (server.isEmpty() || token.isEmpty() || fp.isEmpty()) { deliver(id, 403, new JSONObject()); return; }
          if (!path.startsWith("/api/") || path.length() > 300 || !(method.equals("GET") || method.equals("POST") || method.equals("DELETE"))) throw new Exception("Bad request");
          HttpsURLConnection c = open(server, path, new Pinned(fp), 5000, 120000);
          c.setRequestMethod(method);
          c.setRequestProperty("Authorization", "Bearer " + token);
          if (method.equals("POST")) {
            byte[] payload = (body == null ? "" : body).getBytes(StandardCharsets.UTF_8);
            c.setDoOutput(true); c.setRequestProperty("Content-Type", "application/json"); c.setFixedLengthStreamingMode(payload.length);
            try (OutputStream out = c.getOutputStream()) { out.write(payload); }
          }
          int code = c.getResponseCode();
          InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
          byte[] data = in == null ? new byte[0] : readLimited(in);
          c.disconnect();
          deliver(id, code, data);
        } catch (Exception e) { deliver(id, 0, new byte[0]); }
      }).start();
    }

    /** Looks for servers on this device's own /24 by asking each address for the unauthenticated hello. */
    @JavascriptInterface public void scan(int id) {
      new Thread(() -> {
        JSONArray found = new JSONArray();
        try {
          ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
          LinkProperties lp = cm.getLinkProperties(cm.getActiveNetwork());
          List<Future<JSONObject>> jobs = new ArrayList<>();
          for (LinkAddress la : lp.getLinkAddresses()) {
            if (!(la.getAddress() instanceof Inet4Address)) continue;
            byte[] ip = la.getAddress().getAddress();
            for (int last = 1; last < 255; last++) {
              final String candidate = (ip[0] & 0xff) + "." + (ip[1] & 0xff) + "." + (ip[2] & 0xff) + "." + last;
              jobs.add(scanPool.submit(() -> {
                try (Socket s = new Socket()) { s.connect(new InetSocketAddress(candidate, PORT), 400); } catch (Exception e) { return null; }
                try { return hello(candidate + ":" + PORT, 1500); } catch (Exception e) { return null; }
              }));
            }
            break; // the first IPv4 address is the local network
          }
          for (Future<JSONObject> job : jobs) { JSONObject o = job.get(); if (o != null) found.put(new JSONObject().put("name", o.optString("name")).put("address", o.optString("address"))); }
        } catch (Exception e) { /* report what was found */ }
        try { deliver(id, 200, new JSONObject().put("servers", found)); } catch (Exception e) { deliver(id, 500, new JSONObject()); }
      }).start();
    }
  }
}
