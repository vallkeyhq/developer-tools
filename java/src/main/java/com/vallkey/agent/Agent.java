package com.vallkey.agent;

import static net.bytebuddy.matcher.ElementMatchers.nameStartsWith;
import static net.bytebuddy.matcher.ElementMatchers.named;
import static net.bytebuddy.matcher.ElementMatchers.takesArguments;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.lang.instrument.Instrumentation;
import java.util.Map;
import java.util.Set;
import java.util.jar.JarEntry;
import java.util.jar.JarFile;
import java.util.jar.JarOutputStream;
import net.bytebuddy.agent.builder.AgentBuilder;

/** Instruments supported JDK, OkHttp and Apache HTTP client entry points.
 * See README.md for startup configuration and transport boundaries.
 */
public final class Agent {
    private static final String BOOT = "com/vallkey/agent/boot/Rewrite.class";

    private Agent() {}

    public static void premain(String args, Instrumentation inst) {
        start(inst);
    }

    public static void agentmain(String args, Instrumentation inst) {
        start(inst);
    }

    private static void start(Instrumentation inst) {
        if ("0".equals(System.getenv("VALLKEY_AUTO"))) return;
        try {
            Class<?> rewrite = toBootstrap(inst);
            // HttpURLConnection keeps its headers in sun.net.www.MessageHeader, which Rewrite reads.
            inst.redefineModule(Object.class.getModule(), Set.of(), Map.of("sun.net.www", Set.of(rewrite.getModule())), Map.of(), Set.of(), Map.of());
            AgentBuilder.Transformer.ForAdvice advice = new AgentBuilder.Transformer.ForAdvice().include(Agent.class.getClassLoader());
            new AgentBuilder.Default()
                    .disableClassFormatChanges()
                    .with(AgentBuilder.RedefinitionStrategy.RETRANSFORMATION)
                    .with(AgentBuilder.InitializationStrategy.NoOp.INSTANCE)
                    .with(AgentBuilder.TypeStrategy.Default.REDEFINE)
                    // The JDK's own classes too (the default leaves them out), never the agent's.
                    .ignore(nameStartsWith("com.vallkey.agent."))
                    .assureReadEdgeTo(inst, rewrite)
                    .type(named("okhttp3.Request$Builder"))
                    .transform(advice.advice(named("build").and(takesArguments(0)), OkHttpAdvice.class.getName()))
                    .type(named("jdk.internal.net.http.HttpClientImpl"))
                    .transform(advice.advice(named("sendAsync").and(takesArguments(4)), JdkHttpClientAdvice.class.getName()))
                    .type(named("org.apache.http.impl.client.InternalHttpClient").or(named("org.apache.http.impl.client.MinimalHttpClient")))
                    .transform(advice.advice(named("doExecute").and(takesArguments(3)), Apache4Advice.class.getName()))
                    .type(named("org.apache.hc.client5.http.impl.classic.InternalHttpClient").or(named("org.apache.hc.client5.http.impl.classic.MinimalHttpClient")))
                    .transform(advice.advice(named("doExecute").and(takesArguments(3)), Apache5Advice.class.getName()))
                    .type(named("sun.net.www.protocol.http.HttpURLConnection"))
                    .transform(advice.advice(named("plainConnect0").and(takesArguments(0)), HttpUrlConnectionAdvice.class.getName()))
                    .installOn(inst);
        } catch (Throwable e) {
            // Never stop the app from starting.
            if ("1".equals(System.getenv("VALLKEY_DEBUG"))) System.err.println("[vallkey] the agent could not start: " + e);
        }
    }

    // Rewrite goes to the bootstrap class loader, from a jar of its own, so the code added
    // to any library can call it, wherever that library was loaded from.
    private static Class<?> toBootstrap(Instrumentation inst) throws Exception {
        File jar = File.createTempFile("vallkey-agent-boot", ".jar");
        jar.deleteOnExit();
        try (InputStream in = Agent.class.getClassLoader().getResourceAsStream(BOOT); JarOutputStream out = new JarOutputStream(new FileOutputStream(jar))) {
            out.putNextEntry(new JarEntry(BOOT));
            in.transferTo(out);
            out.closeEntry();
        }
        inst.appendToBootstrapClassLoaderSearch(new JarFile(jar));
        return Class.forName("com.vallkey.agent.boot.Rewrite", true, null);
    }
}
