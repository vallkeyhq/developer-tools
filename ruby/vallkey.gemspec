require_relative "lib/vallkey/version"

Gem::Specification.new do |s|
  s.name = "vallkey"
  s.version = Vallkey::VERSION
  s.summary = "Vallkey runtime integration for Net::HTTP."
  s.description = "Requests that carry a Vallkey ghost key go to Vallkey; nothing else is touched. Turn it on with RUBYOPT=-rvallkey/auto."
  s.authors = ["Vallkey"]
  s.homepage = "https://vallkey.com"
  s.license = "MIT"
  s.files = Dir["lib/**/*.rb"] + ["README.md", "LICENSE"]
  s.required_ruby_version = ">= 2.7"
  s.metadata = { "documentation_uri" => "https://vallkey.com/docs/", "source_code_uri" => "https://github.com/vallkeyhq/developer-tools/tree/main/ruby", "bug_tracker_uri" => "https://github.com/vallkeyhq/developer-tools/issues", "rubygems_mfa_required" => "true" }
end
