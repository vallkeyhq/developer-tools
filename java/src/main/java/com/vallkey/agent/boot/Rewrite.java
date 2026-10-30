package com.vallkey.agent.boot;

import java.lang.reflect.Method;
import java.net.URI;
import java.net.URL;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Decides where a request goes: to Vallkey when it carries a ghost key, otherwise where
 * it was going. The agent loads this class with the bootstrap class loader, so the code it
 * adds to any HTTP library, the JDK's own included, can call it; it uses java.base only.
 *
 * Each request sent to Vallkey says in x-vallkey-host which address it was for, and in
 * x-vallkey-hook what sent it: this agent, Java's version, the platform and VALLKEY_ENV, so
 * the dashboard can show each place a key is used. Never app names or secrets.
 *
 * VALLKEY_API      the Vallkey server (default https://api.vallkey.com)
 * VALLKEY_DEBUG=1  logs each request sent to Vallkey (never the key)
 * VALLKEY_ENV      a name for this place (production, staging…), shown in the dashboard
 */
public final class Rewrite {
    public static final String HOOK_HEADER = "x-vallkey-host";
    public static final String WHO_HEADER = "x-vallkey-hook";
    public static final String VERSION = "0.1.0"; // the same as pom.xml
    // The platform, from variables each one sets itself. The same list, in the same order,
    // is in every Vallkey hook, so the dashboard names a place the same way in any language.
    private static final String[][] PLATFORMS = {
        {"VERCEL", "vercel"}, {"AWS_LAMBDA_FUNCTION_NAME", "aws-lambda"}, {"ECS_CONTAINER_METADATA_URI_V4", "aws-ecs"},
        {"ECS_CONTAINER_METADATA_URI", "aws-ecs"}, {"FUNCTION_TARGET", "cloud-functions"}, {"K_SERVICE", "cloud-run"},
        {"GAE_APPLICATION", "app-engine"}, {"FUNCTIONS_WORKER_RUNTIME", "azure-functions"}, {"CONTAINER_APP_NAME", "azure-container-apps"},
        {"WEBSITE_SITE_NAME", "azure-app-service"}, {"RAILWAY_PROJECT_ID", "railway"}, {"RENDER", "render"}, {"FLY_APP_NAME", "fly"},
        {"DYNO", "heroku"}, {"NETLIFY", "netlify"}, {"KOYEB_APP_NAME", "koyeb"}, {"GITHUB_ACTIONS", "github-actions"},
        {"GITLAB_CI", "gitlab-ci"}, {"KUBERNETES_SERVICE_HOST", "kubernetes"},
    };
    private static volatile String who;
    private static final Pattern GHOST = Pattern.compile("gk_[a-z]{2,20}_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{43}");
    private static final Pattern BASIC = Pattern.compile("^\\s*basic\\s+([A-Za-z0-9+/=]+)\\s*$", Pattern.CASE_INSENSITIVE);
    public static volatile boolean on = true;
    private static volatile Method headersOf;
    private static volatile Method setHeader;

    private Rewrite() {}

    /** Where a request goes: {scheme, host, port, the address it was for}, or null to leave it alone. */
    public static String[] decide(String scheme, String host, int port, String rawQuery, Map<String, List<String>> headers) {
        try {
            if (!on || scheme == null || host == null) return null;
            String s = scheme.toLowerCase(Locale.ROOT);
            if (!s.equals("http") && !s.equals("https")) return null;
            int p = port > 0 ? port : defaultPort(s);
            String[] t = target();
            if (host.equalsIgnoreCase(t[1]) && p == Integer.parseInt(t[2])) return null;
            if (!hasGhost(rawQuery, headers)) return null;
            String from = p == defaultPort(s) ? host : host + ":" + p;
            if ("1".equals(System.getenv("VALLKEY_DEBUG"))) System.err.println("[vallkey] " + s + "://" + from + " -> " + t[0] + "://" + authority(t));
            return new String[] {t[0], t[1], t[2], from};
        } catch (RuntimeException e) {
            return null; // anything unusual goes out as it was
        }
    }

    /** The same, with headers as a flat list: name, value, name, value… */
    public static String[] decide(String scheme, String host, int port, String rawQuery, List<String> pairs) {
        Map<String, List<String>> headers = new java.util.HashMap<>();
        for (int i = 0; i + 1 < pairs.size(); i += 2) {
            List<String> values = headers.get(pairs.get(i));
            if (values == null) headers.put(pairs.get(i), values = new ArrayList<>());
            values.add(pairs.get(i + 1));
        }
        return decide(scheme, host, port, rawQuery, headers);
    }

    /** The address on Vallkey for a path and query. */
    public static String moved(String rawPath, String rawQuery, String[] t) {
        return t[0] + "://" + authority(t) + (rawPath == null || rawPath.isEmpty() ? "/" : rawPath) + (rawQuery == null ? "" : "?" + rawQuery);
    }

    /**
     * HttpURLConnection, just before it connects: the new address, with the address it was
     * for added to its headers, or null. It keeps the headers it sends in `requests` and
     * the ones the app set in `userHeaders`, both sun.net.www.MessageHeader, read and
     * written by reflection (the agent exports that package to this class).
     */
    public static URL huc(URL url, Object requests, Object userHeaders) {
        try {
            if (headersOf == null) {
                setHeader = requests.getClass().getMethod("set", String.class, String.class);
                headersOf = requests.getClass().getMethod("getHeaders");
            }
            @SuppressWarnings("unchecked")
            Map<String, List<String>> headers = (Map<String, List<String>>) headersOf.invoke(requests);
            String[] t = decide(url.getProtocol(), url.getHost(), url.getPort(), url.getQuery(), headers);
            if (t == null) return null;
            // An https connection object cannot carry plain http, nor the other way round.
            if (!t[0].equals(url.getProtocol().toLowerCase(Locale.ROOT))) return null;
            setHeader.invoke(requests, HOOK_HEADER, t[3]);
            setHeader.invoke(userHeaders, HOOK_HEADER, t[3]);
            setHeader.invoke(requests, WHO_HEADER, who());
            setHeader.invoke(userHeaders, WHO_HEADER, who());
            return new URL(t[0], t[1], Integer.parseInt(t[2]), url.getFile());
        } catch (Exception e) {
            return null;
        }
    }

    /** What sent the request, for x-vallkey-hook. */
    public static String who() {
        if (who == null) {
            StringBuilder b = new StringBuilder("java/").append(VERSION).append("; runtime=").append(System.getProperty("java.version"));
            String platform = null;
            for (String[] p : PLATFORMS) {
                String v = System.getenv(p[0]);
                if (v != null && !v.isEmpty()) {
                    platform = p[1];
                    break;
                }
            }
            if (platform == null && new java.io.File("/.dockerenv").exists()) platform = "docker";
            if (platform != null) b.append("; platform=").append(platform);
            String env = System.getenv("VALLKEY_ENV");
            if (env != null && env.matches("[A-Za-z0-9._-]{1,40}")) b.append("; env=").append(env);
            who = b.toString();
        }
        return who;
    }

    private static int defaultPort(String scheme) {
        return scheme.equals("https") ? 443 : 80;
    }

    private static String authority(String[] t) {
        return Integer.parseInt(t[2]) == defaultPort(t[0]) ? t[1] : t[1] + ":" + t[2];
    }

    /** {scheme, host, port} of Vallkey. */
    private static String[] target() {
        String raw = System.getenv("VALLKEY_API");
        URI uri;
        try {
            uri = URI.create(raw == null || raw.isEmpty() ? "https://api.vallkey.com" : raw);
        } catch (IllegalArgumentException e) {
            uri = URI.create("https://api.vallkey.com");
        }
        String scheme = uri.getScheme() == null ? "https" : uri.getScheme().toLowerCase(Locale.ROOT);
        return new String[] {scheme, uri.getHost(), String.valueOf(uri.getPort() > 0 ? uri.getPort() : defaultPort(scheme))};
    }

    private static boolean hasGhost(String rawQuery, Map<String, List<String>> headers) {
        if (rawQuery != null && GHOST.matcher(URLDecoder.decode(rawQuery, StandardCharsets.UTF_8)).find()) return true;
        if (headers == null) return false;
        for (Map.Entry<String, List<String>> e : headers.entrySet()) {
            if (e.getValue() == null) continue;
            for (String v : e.getValue()) if (v != null && inValue(v)) return true;
        }
        return false;
    }

    // A ghost key in a header value, including inside Basic credentials.
    private static boolean inValue(String value) {
        if (GHOST.matcher(value).find()) return true;
        Matcher basic = BASIC.matcher(value);
        if (!basic.matches()) return false;
        try {
            return GHOST.matcher(new String(Base64.getDecoder().decode(basic.group(1)), StandardCharsets.ISO_8859_1)).find();
        } catch (IllegalArgumentException e) {
            return false;
        }
    }
}
