package com.vallkey.agent;

import com.vallkey.agent.boot.Rewrite;
import java.net.URL;
import net.bytebuddy.asm.Advice;

/**
 * HttpURLConnection (Stripe, Spring's RestTemplate, Google's HTTP client…): just before it
 * connects, a connection carrying a ghost key gets Vallkey's address.
 */
public final class HttpUrlConnectionAdvice {
    private HttpUrlConnectionAdvice() {}

    @Advice.OnMethodEnter(suppress = Throwable.class)
    public static void enter(@Advice.FieldValue(value = "url", readOnly = false) URL url, @Advice.FieldValue("requests") Object requests, @Advice.FieldValue("userHeaders") Object userHeaders) {
        URL moved = Rewrite.huc(url, requests, userHeaders);
        if (moved != null) url = moved;
    }
}
