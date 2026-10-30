package com.vallkey.agent;

import com.vallkey.agent.boot.Rewrite;
import java.net.URI;
import java.net.http.HttpRequest;
import java.util.List;
import java.util.Map;
import net.bytebuddy.asm.Advice;

/**
 * The JDK's java.net.http.HttpClient: send and sendAsync both end in HttpClientImpl's
 * four-argument sendAsync, where a request carrying a ghost key is copied with Vallkey's address.
 */
public final class JdkHttpClientAdvice {
    private JdkHttpClientAdvice() {}

    @Advice.OnMethodEnter(suppress = Throwable.class)
    public static void enter(@Advice.Argument(value = 0, readOnly = false) HttpRequest request) {
        if (request == null) return;
        URI uri = request.uri();
        String[] t = Rewrite.decide(uri.getScheme(), uri.getHost(), uri.getPort(), uri.getRawQuery(), request.headers().map());
        if (t == null) return;
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(Rewrite.moved(uri.getRawPath(), uri.getRawQuery(), t)));
        b.method(request.method(), request.bodyPublisher().isPresent() ? request.bodyPublisher().get() : HttpRequest.BodyPublishers.noBody());
        for (Map.Entry<String, List<String>> e : request.headers().map().entrySet()) {
            for (String v : e.getValue()) b.header(e.getKey(), v);
        }
        if (request.timeout().isPresent()) b.timeout(request.timeout().get());
        if (request.version().isPresent()) b.version(request.version().get());
        b.expectContinue(request.expectContinue());
        b.header(Rewrite.HOOK_HEADER, t[3]);
        b.header(Rewrite.WHO_HEADER, Rewrite.who());
        request = b.build();
    }
}
