# Third-party notices

Vallkey source is MIT-licensed. Dependencies remain under their respective licenses.

## Java agent

The agent shades Byte Buddy (`net.bytebuddy:byte-buddy`, version pinned in [java/pom.xml](java/pom.xml)). Its bundled distribution contains Apache License 2.0 and ASM’s BSD notice. The existing release’s exact notices are retained in [java/third-party/Byte-Buddy-LICENSE](java/third-party/Byte-Buddy-LICENSE) and [java/third-party/Byte-Buddy-NOTICE](java/third-party/Byte-Buddy-NOTICE), as well as inside the agent JAR.

OkHttp and Apache HTTP client dependencies are compile-time `provided` dependencies; they are not bundled into the agent. Review third-party notices again when dependency versions or packaging change.

## PHP builds on Alpine Linux

PHP native builds target GNU libc or musl. The musl 1.2.6 copyright and license notice is retained in [php/third-party/musl-COPYRIGHT](php/third-party/musl-COPYRIGHT). Review bundled and dynamically linked dependencies when building a new release.

## Other components

The CLI and Python runtime package have no required third-party runtime dependencies. Test transports, build toolchains, and the Stripe example have dependencies declared in their manifests and lockfiles. Installing them does not relicense their source under MIT.

Provider and platform names identify integrations and remain their owners’ trademarks. No provider logo collection is distributed in this repository.
