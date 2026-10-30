# RUBYOPT=-rvallkey/auto, or require "vallkey/auto": sends requests that carry a ghost
# key to Vallkey. VALLKEY_AUTO=0 turns it off.
require "vallkey"

Vallkey.install unless ENV["VALLKEY_AUTO"] == "0"
