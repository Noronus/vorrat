package app.vorrat.android;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.webkit.CookieManager;

import androidx.annotation.NonNull;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.time.LocalDate;
import java.time.LocalTime;
import java.util.concurrent.TimeUnit;

/**
 * Fragt etwa stündlich beim Server nach, ob etwas abläuft, und zeigt höchstens einmal am Tag
 * (ab der im Server eingestellten Uhrzeit) eine lokale Benachrichtigung. Braucht keinen Google-Push.
 * Meldet sich mit den Cookies des WebViews an (App-Sitzung und ggf. Proxy-Anmeldung).
 */
public class ReminderWorker extends Worker {
    private static final String CHANNEL = "ablauf";
    private static final String WORK = "ablauf-erinnerung";

    public ReminderWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    static void schedule(Context c) {
        Constraints net = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
        PeriodicWorkRequest req = new PeriodicWorkRequest.Builder(ReminderWorker.class, 1, TimeUnit.HOURS).setConstraints(net).build();
        WorkManager.getInstance(c).enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.KEEP, req);
    }

    static void cancel(Context c) {
        WorkManager.getInstance(c).cancelUniqueWork(WORK);
    }

    static void createChannel(Context c) {
        NotificationChannel ch = new NotificationChannel(CHANNEL, "Ablauf-Erinnerungen", NotificationManager.IMPORTANCE_DEFAULT);
        c.getSystemService(NotificationManager.class).createNotificationChannel(ch);
    }

    static void show(Context c, String title, String body) {
        PendingIntent open = PendingIntent.getActivity(c, 0, new Intent(c, MainActivity.class), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new Notification.Builder(c, CHANNEL)
                .setSmallIcon(R.drawable.ic_notif)
                .setColor(c.getColor(R.color.accent))
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setContentIntent(open)
                .setAutoCancel(true)
                .build();
        c.getSystemService(NotificationManager.class).notify(1, n);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context c = getApplicationContext();
        SharedPreferences prefs = c.getSharedPreferences(MainActivity.PREFS, Context.MODE_PRIVATE);
        String server = prefs.getString("server", null);
        String today = LocalDate.now().toString();
        if (server == null || !prefs.getBoolean("notif", false) || today.equals(prefs.getString("notified", ""))) return Result.success();
        HttpURLConnection con = null;
        try {
            con = (HttpURLConnection) new URL(server + "/api/reminders").openConnection();
            con.setConnectTimeout(15000);
            con.setReadTimeout(15000);
            con.setInstanceFollowRedirects(false);
            String cookies = CookieManager.getInstance().getCookie(server);
            if (cookies != null) con.setRequestProperty("Cookie", cookies);
            // Ohne App-Kennung kam die Antwort von einer Anmeldeseite (abgemeldet oder Proxy-PIN abgelaufen): still überspringen
            if (con.getResponseCode() != 200 || con.getHeaderField("X-Vorrat") == null) return Result.success();
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            try (InputStream in = con.getInputStream()) {
                byte[] chunk = new byte[4096];
                for (int n; (n = in.read(chunk)) > 0 && buf.size() < 100_000; ) buf.write(chunk, 0, n);
            }
            JSONObject j = new JSONObject(buf.toString("UTF-8"));
            if (LocalTime.now().getHour() < j.optInt("hour", 9)) return Result.success();
            if (j.optInt("count", 0) > 0) show(c, j.optString("title"), j.optString("body"));
            prefs.edit().putString("notified", today).apply();
        } catch (Exception e) {
            // Kein Netz o. Ä.: beim nächsten Lauf erneut versuchen
        } finally {
            if (con != null) con.disconnect();
        }
        return Result.success();
    }
}
