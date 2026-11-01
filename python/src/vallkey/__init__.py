"""Vallkey for Python. Installing the package turns it on; VALLKEY_AUTO=0 turns it off."""

__all__ = ["install", "uninstall"]
__version__ = "0.3.0"


# Imported lazily: Python loads this package at every start (vallkey_auto.pth), and the
# patch module only loads when the app imports a supported client (see _startup).
def install():
    """Start sending requests that carry a ghost key to Vallkey."""
    from vallkey._patch import install as _install

    _install()


def uninstall():
    """Undo install()."""
    from vallkey._patch import uninstall as _uninstall

    _uninstall()
