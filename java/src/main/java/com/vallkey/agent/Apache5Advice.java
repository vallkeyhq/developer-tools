package com.vallkey.agent;

import com.vallkey.agent.boot.Rewrite;
import java.util.ArrayList;
import java.util.List;
import net.bytebuddy.asm.Advice;

/** Apache HttpClient 5, classic: as for version 4, its doExecute gets Vallkey's host. */
public final class Apache5Advice {
    private Apache5Advice() {}

    @Advice.OnMethodEnter(suppress = Throwable.class)
    public static void enter(@Advice.Argument(value = 0, readOnly = false) org.apache.hc.core5.http.HttpHost target, @Advice.Argument(1) org.apache.hc.core5.http.ClassicHttpRequest request) {
        org.apache.hc.core5.net.URIAuthority authority = request.getAuthority();
        String scheme = request.getScheme() != null ? request.getScheme() : target != null ? target.getSchemeName() : null;
        String host = authority != null ? authority.getHostName() : target != null ? target.getHostName() : null;
        int port = authority != null ? authority.getPort() : target != null ? target.getPort() : -1;
        String path = request.getPath();
        int q = path == null ? -1 : path.indexOf('?');
        List<String> pairs = new ArrayList<>();
        for (org.apache.hc.core5.http.Header h : request.getHeaders()) {
            pairs.add(h.getName());
            pairs.add(h.getValue());
        }
        String[] t = Rewrite.decide(scheme, host, port, q < 0 ? null : path.substring(q + 1), pairs);
        if (t == null) return;
        int p = Integer.parseInt(t[2]);
        request.setScheme(t[0]);
        request.setAuthority(new org.apache.hc.core5.net.URIAuthority(t[1], p));
        target = new org.apache.hc.core5.http.HttpHost(t[0], t[1], p);
        request.removeHeaders("Host");
        request.setHeader(Rewrite.HOOK_HEADER, t[3]);
        request.setHeader(Rewrite.WHO_HEADER, Rewrite.who());
    }
}
