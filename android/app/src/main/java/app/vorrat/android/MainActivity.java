package app.vorrat.android;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Insets;
import android.graphics.Outline;
import android.os.Build;
import android.view.View;
import android.view.ViewOutlineProvider;
import android.window.OnBackInvokedDispatcher;
import android.net.Uri;
import android.os.Bundle;
import android.provider.MediaStore;
import android.text.InputType;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;

import androidx.core.content.FileProvider;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.ResultPoint;
import com.google.zxing.integration.android.IntentIntegrator;
import com.journeyapps.barcodescanner.BarcodeCallback;
import com.journeyapps.barcodescanner.BarcodeResult;
import com.journeyapps.barcodescanner.DecoratedBarcodeView;
import com.journeyapps.barcodescanner.DefaultDecoderFactory;
import com.google.zxing.integration.android.IntentResult;

import org.json.JSONObject;

import java.io.File;
import java.util.Arrays;
import java.util.List;

/**
 * Hülle um die Vorrat-Web-App. Nativ sind: Barcode-Scan (läuft komplett auf dem Gerät),
 * Kamera für Zutaten-Fotos und Ablauf-Erinnerungen (ohne Google-Push, siehe ReminderWorker).
 * Eine vorgeschaltete Proxy-Anmeldung (z. B. NetBird-PIN) erscheint einfach im WebView;
 * deren Cookie bleibt im CookieManager und wird auch vom ReminderWorker mitgeschickt.
 */
public class MainActivity extends Activity {
    static final String PREFS = "vorrat";
    static final String DEFAULT_SERVER = "http://";
    private static final int REQ_FILE = 1, REQ_PERM_CAMERA = 2, REQ_PERM_NOTIF = 3, REQ_PERM_SCAN = 4;

    private WebView web;
    private SharedPreferences prefs;
    private ValueCallback<Uri[]> fileCallback;
    private Uri photoUri;
    private FrameLayout root;
    /** Kamera direkt in der Seite (über der freien Fläche des Scanners) */
    private DecoratedBarcodeView scanView;
    private float[] scanRect;
    private String lastCode;
    private long lastCodeAt;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        ReminderWorker.createChannel(this);

        root = new FrameLayout(this);
        root.setBackgroundColor(getColor(R.color.bg));
        web = new WebView(this);
        web.setBackgroundColor(getColor(R.color.bg));
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);

        // Ab Android 15 zeichnet die App hinter Status- und Navigationsleiste: Abstand selbst setzen
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            Insets i = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
            v.setPadding(i.left, i.top, i.right, i.bottom);
            return WindowInsets.CONSUMED;
        });
        boolean night = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        WindowInsetsController bars = getWindow().getInsetsController();
        if (bars != null) {
            int light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
            bars.setSystemBarsAppearance(night ? 0 : light, light);
        }

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUserAgentString(s.getUserAgentString() + " VorratApp/1.0");
        CookieManager.getInstance().setAcceptCookie(true);
        web.addJavascriptInterface(new Bridge(), "VorratNative");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showOffline();
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) openPhotoChooser();
                else requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_PERM_CAMERA);
                return true;
            }
        });

        if (state != null) web.restoreState(state);
        else if (serverUrl() == null) askServer();
        else web.loadUrl(serverUrl());

        if (prefs.getBoolean("notif", false)) ReminderWorker.schedule(this);

        // Ab Android 16 (targetSdk 36) ruft das System onBackPressed nicht mehr auf
        if (Build.VERSION.SDK_INT >= 33)
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBack);
    }

    /** Zurück: erst offenes Fenster in der Web-App schließen, dann eine Seite zurück, sonst App in den Hintergrund */
    private void handleBack() {
        web.evaluateJavascript("window.vorratBack ? window.vorratBack() : false", res -> {
            if ("true".equals(res)) return;
            if (web.canGoBack()) web.goBack();
            else moveTaskToBack(true);
        });
    }

    // ---------- Eingebettete Kamera ----------
    private void showScanView(float[] r) {
        scanRect = r;
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_PERM_SCAN);
            return;
        }
        float d = getResources().getDisplayMetrics().density;
        if (scanView == null) {
            scanView = new DecoratedBarcodeView(this);
            scanView.setStatusText("");
            scanView.getBarcodeView().setDecoderFactory(new DefaultDecoderFactory(
                    Arrays.asList(BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E)));
            float radius = 24 * d;
            scanView.setOutlineProvider(new ViewOutlineProvider() {
                @Override
                public void getOutline(View v, Outline o) { o.setRoundRect(0, 0, v.getWidth(), v.getHeight(), radius); }
            });
            scanView.setClipToOutline(true);
            scanView.decodeContinuous(new BarcodeCallback() {
                @Override
                public void barcodeResult(BarcodeResult result) {
                    String code = result.getText();
                    long now = System.currentTimeMillis();
                    // Derselbe Code mehrfach hintereinander: nur einmal melden
                    if (code == null || (code.equals(lastCode) && now - lastCodeAt < 2500)) return;
                    lastCode = code;
                    lastCodeAt = now;
                    emit("vorrat:native-scan", JSONObject.quote(code));
                }

                @Override
                public void possibleResultPoints(List<ResultPoint> points) { }
            });
        }
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(Math.round(r[2] * d), Math.round(r[3] * d));
        lp.leftMargin = Math.round(r[0] * d);
        lp.topMargin = Math.round(r[1] * d);
        if (scanView.getParent() == null) root.addView(scanView, lp);
        else scanView.setLayoutParams(lp);
        scanView.resume();
    }

    private void hideScanView() {
        scanRect = null;
        if (scanView == null) return;
        scanView.pause();
        root.removeView(scanView);
    }

    private String serverUrl() {
        return prefs.getString("server", null);
    }

    private void askServer() {
        EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        input.setText(serverUrl() != null ? serverUrl() : DEFAULT_SERVER);
        int pad = (int) (20 * getResources().getDisplayMetrics().density);
        FrameLayout box = new FrameLayout(this);
        box.setPadding(pad, pad / 2, pad, 0);
        box.addView(input);
        new AlertDialog.Builder(this)
                .setTitle("Adresse deines Vorrat-Servers")
                .setMessage("Zu Hause z. B. http://192.168.1.10:8095, von unterwegs deine https-Adresse.")
                .setView(box)
                .setCancelable(serverUrl() != null)
                .setPositiveButton("Verbinden", (d, w) -> {
                    String url = input.getText().toString().trim().replaceAll("/+$", "");
                    if (url.isEmpty()) { askServer(); return; }
                    if (!url.matches("^https?://.*")) url = "https://" + url;
                    prefs.edit().putString("server", url).apply();
                    web.clearHistory();
                    web.loadUrl(url);
                })
                .show();
    }

    private void showOffline() {
        String html = "<html><head><meta name='viewport' content='width=device-width,initial-scale=1'><style>"
                + "body{font:16px system-ui;padding:32px 24px;text-align:center;background:#f4f6f1;color:#1b2118}"
                + "@media(prefers-color-scheme:dark){body{background:#12150f;color:#e9eee4}}"
                + "button{display:block;width:100%;margin:12px 0;padding:14px;border-radius:12px;border:0;font:600 16px system-ui;background:#2f7d4f;color:#fff}"
                + "button.b{background:transparent;color:inherit;border:1px solid #8886}</style></head><body>"
                + "<h2>Server nicht erreichbar</h2><p>Kein Netz, oder die Adresse stimmt nicht.</p>"
                + "<button onclick='VorratNative.retry()'>Nochmal versuchen</button>"
                + "<button class='b' onclick='VorratNative.changeServer()'>Server-Adresse ändern</button></body></html>";
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    // ---------- Barcode-Scan (ZXing, lokal auf dem Gerät) ----------
    private void startScan() {
        IntentIntegrator i = new IntentIntegrator(this);
        i.setDesiredBarcodeFormats(IntentIntegrator.PRODUCT_CODE_TYPES);
        i.setPrompt("Barcode ins Feld halten");
        i.setBeepEnabled(false);
        i.setOrientationLocked(true);
        i.initiateScan();
    }

    // ---------- Foto für „Foto von Zutaten“ ----------
    private void openPhotoChooser() {
        Intent gallery = new Intent(Intent.ACTION_GET_CONTENT).setType("image/*").addCategory(Intent.CATEGORY_OPENABLE);
        Intent chooser = gallery;
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            File dir = new File(getCacheDir(), "fotos");
            dir.mkdirs();
            File file = new File(dir, "zutaten.jpg");
            file.delete();
            photoUri = FileProvider.getUriForFile(this, getPackageName() + ".files", file);
            Intent camera = new Intent(MediaStore.ACTION_IMAGE_CAPTURE).putExtra(MediaStore.EXTRA_OUTPUT, photoUri);
            camera.setClipData(ClipData.newRawUri("", photoUri));
            camera.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            chooser = Intent.createChooser(camera, "Foto von Zutaten");
            chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[]{gallery});
        }
        try {
            startActivityForResult(chooser, REQ_FILE);
        } catch (Exception e) {
            finishFile(null);
        }
    }

    private void finishFile(Uri uri) {
        if (fileCallback != null) fileCallback.onReceiveValue(uri == null ? null : new Uri[]{uri});
        fileCallback = null;
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE) {
            Uri uri = null;
            if (resultCode == RESULT_OK) {
                if (data != null && data.getData() != null) uri = data.getData();
                else if (photoUri != null && new File(new File(getCacheDir(), "fotos"), "zutaten.jpg").length() > 0) uri = photoUri;
            }
            finishFile(uri);
            return;
        }
        IntentResult scan = IntentIntegrator.parseActivityResult(requestCode, resultCode, data);
        if (scan != null) {
            emit("vorrat:native-scan", scan.getContents() == null ? "null" : JSONObject.quote(scan.getContents()));
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        boolean granted = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
        if (requestCode == REQ_PERM_CAMERA) openPhotoChooser();
        if (requestCode == REQ_PERM_SCAN) {
            if (granted && scanRect != null) showScanView(scanRect);
            else if (!granted) emit("vorrat:toast", JSONObject.quote("Ohne Kamera-Erlaubnis geht kein Scan. Du kannst den Barcode eintippen."));
        }
        if (requestCode == REQ_PERM_NOTIF) applyNotifications(granted);
    }

    private void applyNotifications(boolean on) {
        prefs.edit().putBoolean("notif", on).apply();
        if (on) ReminderWorker.schedule(this);
        else ReminderWorker.cancel(this);
        emit("vorrat:native-notif", String.valueOf(on));
    }

    /** Ereignis an die Web-App schicken; detailJson muss gültiges JSON sein */
    private void emit(String event, String detailJson) {
        web.evaluateJavascript("window.dispatchEvent(new CustomEvent('" + event + "',{detail:" + detailJson + "}))", null);
    }

    /** Aus der Web-App erreichbar als window.VorratNative */
    private class Bridge {
        @JavascriptInterface
        public void scan() {
            runOnUiThread(MainActivity.this::startScan);
        }

        @JavascriptInterface
        public void share(String title, String text) {
            Intent send = new Intent(Intent.ACTION_SEND).setType("text/plain")
                    .putExtra(Intent.EXTRA_SUBJECT, title).putExtra(Intent.EXTRA_TEXT, text);
            runOnUiThread(() -> startActivity(Intent.createChooser(send, title)));
        }

        @JavascriptInterface
        public void scanStart(float x, float y, float w, float h) {
            runOnUiThread(() -> showScanView(new float[]{x, y, w, h}));
        }

        @JavascriptInterface
        public void scanStop() {
            runOnUiThread(MainActivity.this::hideScanView);
        }

        @JavascriptInterface
        public boolean torch(boolean on) {
            if (!getPackageManager().hasSystemFeature(PackageManager.FEATURE_CAMERA_FLASH)) return false;
            runOnUiThread(() -> { if (scanView != null) { if (on) scanView.setTorchOn(); else scanView.setTorchOff(); } });
            return true;
        }

        @JavascriptInterface
        public boolean notificationsEnabled() {
            return prefs.getBoolean("notif", false) && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
        }

        @JavascriptInterface
        public void setNotifications(boolean on) {
            runOnUiThread(() -> {
                if (on && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
                    requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_PERM_NOTIF);
                else applyNotifications(on);
            });
        }

        @JavascriptInterface
        public void testNotification() {
            ReminderWorker.show(MainActivity.this, "Vorrat", "Erinnerungen funktionieren.");
        }

        @JavascriptInterface
        public void changeServer() {
            runOnUiThread(MainActivity.this::askServer);
        }

        @JavascriptInterface
        public void retry() {
            runOnUiThread(() -> { if (serverUrl() != null) web.loadUrl(serverUrl()); else askServer(); });
        }
    }

    @Override
    public void onBackPressed() {
        handleBack();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (scanView != null && scanView.getParent() != null) scanView.resume();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (scanView != null) scanView.pause();
        CookieManager.getInstance().flush(); // Anmeldung sicher auf die Platte schreiben
    }
}
