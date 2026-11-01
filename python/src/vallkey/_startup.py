# Runs when Python starts (from vallkey_auto.pth): installing the package turns it on,
# with no import or variable in your code. Only requests that carry a ghost key are
# changed. VALLKEY_AUTO=0 turns it off, also from a .env file loaded later, because each
# request checks it again. It never stops Python starting.
#
# This runs in every Python process in the environment, most of which never send a
# request, so the patch module waits until a supported client is imported.
import os
import sys

WATCHED = frozenset(("httpx", "httpx2", "requests", "urllib3", "botocore.httpsession", "aiohttp", "urllib.request"))


def _start():
    from vallkey._patch import _finder, install

    install()
    return _finder


class _Lazy:
    _vallkey_lazy = True

    def find_spec(self, fullname, path=None, target=None):
        if fullname not in WATCHED:
            return None
        try:
            finder = _start()
            if self in sys.meta_path:
                sys.meta_path.remove(self)
            # This import has passed the patch's own finder, which was just added first.
            return finder.find_spec(fullname, path, target)
        except Exception:
            return None


if os.environ.get("VALLKEY_AUTO") != "0":
    try:
        if WATCHED.intersection(sys.modules):
            _start()  # another package loaded a client before this ran
        else:
            sys.meta_path.insert(0, _Lazy())
    except Exception:  # pragma: no cover
        pass
