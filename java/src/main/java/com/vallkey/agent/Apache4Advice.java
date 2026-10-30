package com.vallkey.agent;

import com.vallkey.agent.boot.Rewrite;
import java.net.URI;
import java.util.ArrayList;
import java.util.List;
import net.bytebuddy.asm.Advice;

/**
 * Apache HttpClient 4 (the AWS SDK, Twilio, SendGrid…): every execute() ends in doExecute
 * with the host to connect to; for a request carrying a ghost key that becomes Vallkey's.
 */
public final class Apache4Advice {
    private Apache4Advice() {}

    @Advice.OnMethodEnter(suppress = Throwable.class)
    public static void enter(@Advice.Argument(value = 0, readOnly = false) org.apache.http.HttpHost target, @Advice.Argument(1) org.apache.http.HttpRequest request) {
        URI uri = URI.create(request.getRequestLine().getUri());
        String scheme = target != null ? target.getSchemeName() : uri.getScheme();
        String host = target != null ? target.getHostName() : uri.getHost();
        int port = target != null ? target.getPort() : uri.getPort();
        List<String> pairs = new ArrayList<>();
        for (org.apache.http.Header h : request.getAllHeaders()) {
            pairs.add(h.getName());
            pairs.add(h.getValue());
        }
        String[] t = Rewrite.decide(scheme, host, port, uri.getRawQuery(), pairs);
        if (t == null) return;
        target = new org.apache.http.HttpHost(t[1], Integer.parseInt(t[2]), t[0]);
        if (uri.isAbsolute()) {
            URI moved = URI.create(Rewrite.moved(uri.getRawPath(), uri.getRawQuery(), t));
            if (request instanceof org.apache.http.client.methods.HttpRequestBase) ((org.apache.http.client.methods.HttpRequestBase) request).setURI(moved);
            else if (request instanceof org.apache.http.client.methods.HttpRequestWrapper) ((org.apache.http.client.methods.HttpRequestWrapper) request).setURI(moved);
        }
        request.removeHeaders("Host");
        request.setHeader(Rewrite.HOOK_HEADER, t[3]);
        request.setHeader(Rewrite.WHO_HEADER, Rewrite.who());
    }
}
