package com.vallkey.agent;

import com.vallkey.agent.boot.Rewrite;
import net.bytebuddy.asm.Advice;

/**
 * OkHttp (OpenAI, Anthropic, Slack, Resend…): every request is made by Request.Builder.build(),
 * including the copies interceptors make to add a key, so the one carrying a ghost key is
 * built for Vallkey instead.
 */
public final class OkHttpAdvice {
    private OkHttpAdvice() {}

    @Advice.OnMethodExit(suppress = Throwable.class)
    public static void exit(@Advice.Return(readOnly = false) okhttp3.Request request) {
        if (request == null) return;
        okhttp3.HttpUrl url = request.url();
        String[] t = Rewrite.decide(url.scheme(), url.host(), url.port(), url.encodedQuery(), request.headers().toMultimap());
        if (t == null) return;
        okhttp3.HttpUrl moved = url.newBuilder().scheme(t[0]).host(t[1]).port(Integer.parseInt(t[2])).build();
        request = request.newBuilder().url(moved).removeHeader("Host").header(Rewrite.HOOK_HEADER, t[3]).header(Rewrite.WHO_HEADER, Rewrite.who()).build();
    }
}
