require "minitest/autorun"
require "json"
require "open3"
require "socket"

# Shaped like a ghost key, put together at run time.
GHOST = ["gk", "openai", "A1b2C3d4E5f6G7h8I9j0Kl", "M1n2O3p4Q5r6S7t8U9v0Wx1Y2z3A4b5C6d7E8f9G0hI"].join("_")
LIB = File.expand_path("../lib", __dir__)

# A small HTTP server that records what it is sent and says who it is.
class Recorder
  attr_reader :port, :seen

  def initialize(name)
    @name = name
    @seen = Queue.new
    @server = TCPServer.new("127.0.0.1", 0)
    @port = @server.addr[1]
    @thread = Thread.new { loop { Thread.new(@server.accept) { |c| serve(c) } } }
  end

  def serve(client)
    loop do
      line = client.gets or break
      method, path = line.split(" ")
      headers = {}
      while (h = client.gets) && h != "\r\n"
        k, v = h.split(":", 2)
        headers[k.downcase] = v.strip
      end
      body = headers["content-length"] ? client.read(headers["content-length"].to_i) : ""
      @seen << { "server" => @name, "method" => method, "path" => path, "headers" => headers, "body" => body }
      answer = JSON.generate("from" => @name)
      client.write("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: #{answer.bytesize}\r\n\r\n#{answer}")
    end
  ensure
    client.close
  end

  def last
    @seen.pop
  end

  def close
    @thread.kill
    @server.close
  end
end

class AutoTest < Minitest::Test
  def setup
    @vallkey = Recorder.new("vallkey")
    @provider = Recorder.new("provider")
  end

  def teardown
    @vallkey.close
    @provider.close
  end

  def ruby(code, env = {})
    full = { "VALLKEY_API" => "http://127.0.0.1:#{@vallkey.port}", "GHOST" => GHOST, "PROVIDER" => "http://127.0.0.1:#{@provider.port}", "RUBYOPT" => "-I#{LIB} -rvallkey/auto" }.merge(env)
    out, err, status = Open3.capture3(full, RbConfig.ruby, "-e", code)
    assert status.success?, err
    [out.strip, err]
  end

  def test_sends_requests_with_a_ghost_key_to_vallkey_keeping_path_query_and_body
    out, = ruby(<<~RUBY)
      require "net/http"
      require "json"
      http = Net::HTTP.new("api.openai.com", 443)
      http.use_ssl = true
      req = Net::HTTP::Post.new("/v1/chat/completions?x=1", "Authorization" => "Bearer \#{ENV['GHOST']}", "Content-Type" => "application/json")
      puts JSON.parse(http.request(req, '{"model":"m"}').body)["from"]
    RUBY
    assert_equal "vallkey", out
    sent = @vallkey.last
    assert_equal ["POST", "/v1/chat/completions?x=1", '{"model":"m"}', "api.openai.com", "127.0.0.1:#{@vallkey.port}"],
                 [sent["method"], sent["path"], sent["body"], sent["headers"]["x-vallkey-host"], sent["headers"]["host"]]
  end

  def test_says_what_sent_the_request
    out, = ruby(<<~RUBY, "DYNO" => "web.1", "VALLKEY_ENV" => "production")
      require "net/http"
      require "json"
      puts JSON.parse(Net::HTTP.get(URI("\#{ENV['PROVIDER']}/x"), { "x-api-key" => ENV["GHOST"] }))["from"]
    RUBY
    assert_equal "vallkey", out
    require_relative "../lib/vallkey/version"
    assert_equal "ruby/#{Vallkey::VERSION}; runtime=#{RUBY_VERSION}; platform=heroku; env=production", @vallkey.last["headers"]["x-vallkey-hook"]
  end

  def test_leaves_requests_without_a_ghost_key_alone
    out, = ruby(<<~RUBY)
      require "net/http"
      require "json"
      puts JSON.parse(Net::HTTP.get(URI("\#{ENV['PROVIDER']}/plain"), { "Authorization" => "Bearer sk-real" }))["from"]
    RUBY
    assert_equal "provider", out
  end

  def test_basic_credentials_keys_in_the_query_and_a_kept_open_connection
    out, = ruby(<<~RUBY)
      require "net/http"
      require "json"
      Net::HTTP.start("api.twilio.com", 443, use_ssl: true) do |http|
        a = Net::HTTP::Get.new("/2010-04-01/Accounts.json")
        a.basic_auth("AC1", ENV["GHOST"])
        b = Net::HTTP::Get.new("/v1beta/models?key=\#{ENV['GHOST']}")
        puts [http.request(a), http.request(b)].map { |r| JSON.parse(r.body)["from"] }.join(" ")
      end
    RUBY
    assert_equal "vallkey vallkey", out
    assert_equal "/2010-04-01/Accounts.json", @vallkey.last["path"]
    assert @vallkey.last["path"].start_with?("/v1beta/models?key=gk_")
  end

  def test_a_started_connection_only_opens_for_requests_that_stay_with_the_provider
    out, = ruby(<<~RUBY)
      require "net/http"
      require "json"
      # Nothing listens at this address: starting there must not connect yet.
      http = Net::HTTP.new("127.0.0.1", 9)
      http.start
      req = Net::HTTP::Get.new("/v1/models", "Authorization" => "Bearer \#{ENV['GHOST']}")
      a = JSON.parse(http.request(req).body)["from"]
      uri = URI(ENV["PROVIDER"])
      plain = Net::HTTP.new(uri.host, uri.port)
      plain.start
      b = JSON.parse(plain.request(Net::HTTP::Get.new("/plain")).body)["from"]
      c = JSON.parse(plain.request(Net::HTTP::Get.new("/again")).body)["from"]
      plain.finish
      puts [a, b, c].join(" ")
    RUBY
    assert_equal "vallkey provider provider", out
  end

  def test_covers_net_http_loaded_after_it_and_can_be_turned_off
    code = <<~RUBY
      require "net/http"
      require "json"
      puts JSON.parse(Net::HTTP.get(URI("\#{ENV['PROVIDER']}/x"), { "x-api-key" => ENV["GHOST"] }))["from"]
    RUBY
    assert_equal "vallkey", ruby(code)[0]
    assert_equal "provider", ruby(code, "VALLKEY_AUTO" => "0")[0]
  end

  def test_says_what_it_does_without_showing_the_key
    _, err = ruby(<<~RUBY, "VALLKEY_DEBUG" => "1")
      require "net/http"
      Net::HTTP.get(URI("\#{ENV['PROVIDER']}/v1/x?key=\#{ENV['GHOST']}"))
    RUBY
    assert_match %r{\[vallkey\] http://127\.0\.0\.1:\d+ -> http://127\.0\.0\.1:\d+}, err
    refute_includes err, GHOST
    refute_includes err, "/v1/x"
  end
end
