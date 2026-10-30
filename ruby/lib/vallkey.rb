require "vallkey/version"
require "vallkey/patch"

# Vallkey for Ruby. Start with RUBYOPT=-rvallkey/auto, or require "vallkey/auto".
module Vallkey
  def self.install
    Patch.install
  end

  def self.uninstall
    Patch.uninstall
  end
end
