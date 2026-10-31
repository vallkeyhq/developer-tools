# Runs when Python starts (from vallkey_auto.pth): installing the package turns it on,
# with no import or variable in your code. Only requests that carry a ghost key are
# changed. VALLKEY_AUTO=0 turns it off, also from a .env file loaded later, because each
# request checks it again. It never stops Python starting.
import os

if os.environ.get("VALLKEY_AUTO") != "0":
    try:
        from vallkey._patch import install

        install()
    except Exception:  # pragma: no cover
        pass
