# Runs when Python starts (from vallkey_auto.pth), so VALLKEY_AUTO=1 needs no import
# in your code. It does nothing unless VALLKEY_AUTO=1, and never stops Python starting.
import os

if os.environ.get("VALLKEY_AUTO") == "1":
    try:
        from vallkey._patch import install

        install()
    except Exception:  # pragma: no cover
        pass
