"""Vallkey for Python. See vallkey.auto, or set VALLKEY_AUTO=1."""

__all__ = ["install", "uninstall"]
__version__ = "0.3.0"


# Imported lazily: Python loads this package at every start (vallkey_auto.pth), and
# when VALLKEY_AUTO is not set that should cost nothing.
def install():
    """Start sending requests that carry a ghost key to Vallkey."""
    from vallkey._patch import install as _install

    _install()


def uninstall():
    """Undo install()."""
    from vallkey._patch import uninstall as _uninstall

    _uninstall()
