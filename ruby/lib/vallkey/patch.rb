# Redirect recognized ghost credentials in Net::HTTP requests.
# Install after Net::HTTP loads so Bundler retains control of its version.
# See README.md for configuration and transport boundaries.
module Vallkey
  module Patch
    GHOST = /gk_[a-z]{2,20}_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{43}/.freeze
    HOOK_HEADER = "x-vallkey-host".freeze
    WHO_HEADER = "x-vallkey-hook".freeze

    # The platform, from variables each one sets itself. The same list, in the same order,
    # is in every Vallkey hook, so the dashboard names a place the same way in any language.
    PLATFORMS = [
      %w[VERCEL vercel], %w[AWS_LAMBDA_FUNCTION_NAME aws-lambda], %w[ECS_CONTAINER_METADATA_URI_V4 aws-ecs],
      %w[ECS_CONTAINER_METADATA_URI aws-ecs], %w[FUNCTION_TARGET cloud-functions], %w[K_SERVICE cloud-run],
      %w[GAE_APPLICATION app-engine], %w[FUNCTIONS_WORKER_RUNTIME azure-functions], %w[CONTAINER_APP_NAME azure-container-apps],
      %w[WEBSITE_SITE_NAME azure-app-service], %w[RAILWAY_PROJECT_ID railway], %w[RENDER render], %w[FLY_APP_NAME fly],
      %w[DYNO heroku], %w[NETLIFY netlify], %w[KOYEB_APP_NAME koyeb], %w[GITHUB_ACTIONS github-actions],
      %w[GITLAB_CI gitlab-ci], %w[KUBERNETES_SERVICE_HOST kubernetes]
    ].freeze

    Target = Struct.new(:scheme, :host, :port) do
      def host_with_port
        default = scheme == "https" ? 443 : 80
        port == default ? host : "#{host}:#{port}"
      end
    end

    class << self
      attr_reader :installed

      def install
        return if @installed
        @installed = true
        patch_net_http if defined?(::Net::HTTP)
        watch_requires unless @net_http
      end

      def uninstall
        @installed = false
      end

      def target
        raw = ENV["VALLKEY_API"].to_s.empty? ? "https://api.vallkey.com" : ENV["VALLKEY_API"]
        m = %r{\A(https?)://([^/:]+)(?::(\d+))?}.match(raw)
        return Target.new("https", "api.vallkey.com", 443) unless m
        Target.new(m[1], m[2], (m[3] || (m[1] == "https" ? 443 : 80)).to_i)
      end

      # A ghost key in a header value, including inside Basic credentials.
      def in_value?(value)
        text = value.to_s
        return true if GHOST.match?(text)
        basic = /\A\s*basic\s+([A-Za-z0-9+\/=]+)\s*\z/i.match(text)
        return false unless basic
        GHOST.match?(basic[1].unpack1("m").to_s)
      rescue StandardError
        false
      end

      def ghost?(path, headers, body)
        query = path.to_s.split("?", 2)[1]
        return true if query && GHOST.match?(unescape(query))
        headers.each { |_, value| return true if in_value?(value) }
        body.is_a?(String) && GHOST.match?(body.b)
      end

      def unescape(text)
        text.gsub(/%([0-9A-Fa-f]{2})/) { Regexp.last_match(1).hex.chr }.gsub("+", " ")
      end

      def who
        @who ||= begin
          parts = ["ruby/#{Vallkey::VERSION}", "runtime=#{RUBY_VERSION}"]
          platform = PLATFORMS.find { |name, _| !ENV[name].to_s.empty? }&.last
          platform ||= "docker" if File.exist?("/.dockerenv")
          parts << "platform=#{platform}" if platform
          place = ENV["VALLKEY_ENV"].to_s
          parts << "env=#{place}" if place.match?(/\A[A-Za-z0-9._-]{1,40}\z/)
          parts.join("; ").freeze
        end
      end

      def log(from, to)
        warn "[vallkey] #{from} -> #{to}" if ENV["VALLKEY_DEBUG"] == "1"
      end

      def patch_net_http
        return if @net_http
        @net_http = true
        ::Net::HTTP.prepend(NetHTTP)
      end

      # Patches Net::HTTP as soon as anything loads it (require, or an autoload).
      def watch_requires
        return if @watching
        @watching = true
        ::Kernel.module_eval do
          alias_method :vallkey_original_require, :require
          class << self
            alias_method :vallkey_original_require, :require
          end

          def require(path)
            loaded = vallkey_original_require(path)
            Vallkey::Patch.patch_net_http if loaded && defined?(::Net::HTTP) && Vallkey::Patch.installed
            loaded
          end
          module_function :require
        end
      end

      # One kept-open connection to Vallkey for each thread, as the app's own one to the
      # provider would be; a forked worker opens its own.
      def connection(target, from)
        cache = (Thread.current[:__vallkey_connections] ||= {})
        key = [Process.pid, target.scheme, target.host, target.port]
        http = cache[key]
        unless http
          http = ::Net::HTTP.new(target.host, target.port)
          http.use_ssl = target.scheme == "https"
          cache[key] = http
        end
        %i[open_timeout read_timeout write_timeout ssl_timeout continue_timeout keep_alive_timeout].each do |name|
          next unless from.respond_to?(name) && http.respond_to?("#{name}=")
          value = from.public_send(name)
          http.public_send("#{name}=", value) unless value.nil?
        end
        http
      end
    end

    module NetHTTP
      # Most libraries start the connection first and send requests on it after
      # (Faraday, the AWS SDK, connection pools): the connection is only opened when the
      # first request that stays with the provider is sent, so one whose ghost key sends
      # it to Vallkey never opens a connection to the provider at all.
      def request(req, body = nil, &block)
        moved = Vallkey::Patch.installed && Vallkey::Patch.redirect?(self, req, body)
        unless moved
          if @vallkey_deferred
            @vallkey_deferred = false
            connect
          end
          return super
        end
        target, from = moved
        req.delete("host")
        req[HOOK_HEADER] = from
        req[WHO_HEADER] = Vallkey::Patch.who
        req["host"] = target.host_with_port
        http = Vallkey::Patch.connection(target, self)
        http.start unless http.started?
        http.request(req, body, &block)
      end

      private

      def do_start
        return super unless Vallkey::Patch.installed
        @vallkey_deferred = true
        @started = true
      end

      def do_finish
        @vallkey_deferred = false
        super
      end
    end

    class << self
      def redirect?(http, req, body)
        t = target
        return false if http.address == t.host && http.port == t.port
        headers = []
        req.each_header { |name, value| headers << [name, value] }
        return false unless ghost?(req.path, headers, body || req.body)
        scheme = http.use_ssl? ? "https" : "http"
        default = http.use_ssl? ? 443 : 80
        from = http.port == default ? http.address : "#{http.address}:#{http.port}"
        log("#{scheme}://#{from}", "#{t.scheme}://#{t.host_with_port}")
        [t, from]
      rescue StandardError
        false # anything unusual goes out as it was
      end
    end
  end
end
