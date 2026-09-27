"""Nocheh tools and the pinned Hermes tool modules share one import namespace."""

from pkgutil import extend_path

__path__ = extend_path(__path__, __name__)


def check_file_requirements():
    """Preserve the native Hermes package's public tool availability check."""
    from .terminal_tool import check_terminal_requirements
    return check_terminal_requirements()


__all__ = ['check_file_requirements']
