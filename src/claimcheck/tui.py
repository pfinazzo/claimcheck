"""A small terminal toolkit: color, typewriter text, shimmer, progress bars, spinners, decode effects.

Standard library only. Everything degrades on its own: with no terminal, NO_COLOR, TERM=dumb or CI
set, animations are replaced by their final frame and colors by plain text, so scripts and logs stay
clean. Output, input and sleep are injectable so the whole thing can be tested without a console.


@author Patrick Finazzo
"""

from __future__ import annotations

import atexit
import ctypes
import itertools
import os
import random
import re
import shutil
import sys
import threading
import time
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from typing import TextIO, TypedDict

ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
CSI = "\x1b["
HIDE_CURSOR, SHOW_CURSOR, CLEAR_LINE = CSI + "?25l", CSI + "?25h", CSI + "2K"

_STYLES = {
    "bold": "1", "dim": "2", "italic": "3", "underline": "4",
    "red": "31", "green": "32", "yellow": "33", "blue": "34", "magenta": "35", "cyan": "36", "white": "97", "grey": "90",
}

GLYPHS_UNICODE = {
    "ok": "✓", "bad": "✗", "next": "▸", "dot": "●", "ring": "○", "lock": "■", "spin": "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏",
    "bar_full": "█", "bar_empty": "░", "h": "─", "v": "│", "tl": "╭", "tr": "╮", "bl": "╰", "br": "╯", "arrow": "→",
    "bug": "◆",
}
GLYPHS_ASCII = {
    "ok": "+", "bad": "x", "next": ">", "dot": "*", "ring": "o", "lock": "#", "spin": "|/-\\",
    "bar_full": "#", "bar_empty": "-", "h": "-", "v": "|", "tl": "+", "tr": "+", "bl": "+", "br": "+", "arrow": "->",
    "bug": "*",
}


def strip_ansi(s: str) -> str:
    """The text without color and cursor escape codes, for measuring its width."""
    return ANSI.sub("", s)


def _set_vt_mode(kernel, *, std: int) -> None:
    """Add ENABLE_VIRTUAL_TERMINAL_PROCESSING to one standard handle's console mode, if it has one."""
    handle = kernel.GetStdHandle(std)
    mode = ctypes.c_uint32()
    if kernel.GetConsoleMode(handle, ctypes.byref(mode)):
        kernel.SetConsoleMode(handle, mode.value | 0x0004)


def set_windows_vt() -> None:
    """Turn on ANSI escape handling in the classic Windows console. Harmless elsewhere."""
    if os.name != "nt":
        return
    try:
        kernel = ctypes.windll.kernel32  # type: ignore[attr-defined]
        # -11 is stdout, -12 is stderr.
        for std in (-11, -12):
            _set_vt_mode(kernel, std=std)
    except (AttributeError, OSError):
        # An old console without these calls keeps its default mode. The text still prints;
        # only the colors show up as escape codes.
        return


def _pick_bar_color(frac: float) -> str:
    """Green from 70% up, yellow from 40%, red below."""
    if frac >= 0.7:
        return "green"
    return "yellow" if frac >= 0.4 else "red"


def detect(stream=None, *, env: Mapping[str, str] | None = None) -> dict:
    """Which features this terminal gets: {"tty", "color", "animate", "unicode"}."""
    stream = stream if stream is not None else sys.stdout
    env = env if env is not None else os.environ
    tty = bool(getattr(stream, "isatty", lambda: False)()) and bool(getattr(sys.stdin, "isatty", lambda: False)())
    dumb = env.get("TERM") == "dumb"
    color = tty and not dumb and "NO_COLOR" not in env
    animate = color and not env.get("CI") and not env.get("CLAIMCHECK_NO_ANIMATION")
    enc = (getattr(stream, "encoding", None) or "").lower()
    unicode_ok = "utf" in enc
    return {"tty": tty, "color": color, "animate": animate, "unicode": unicode_ok}


# A terminal and what it can do. Every drawing function takes one; `make_term` detects the rest.
# `cursor_hidden` is the one field that changes: it records whether the cursor needs showing again.
Term = TypedDict(
    "Term",
    {
        "out": TextIO,
        "read_input": Callable[[str], str],
        "sleep": Callable[[float], None],
        "color": bool,
        "animate": bool,
        "unicode": bool,
        "glyphs": dict[str, str],
        "fixed_width": int | None,
        "rng": random.Random,
        "cursor_hidden": bool,
    },
)


def make_term(
    out: TextIO | None = None,
    *,
    read_input: Callable[[str], str] | None = None,
    animate: bool | None = None,
    color: bool | None = None,
    unicode: bool | None = None,
    sleep: Callable[[float], None] = time.sleep,
    width: int | None = None,
    seed: int | None = None,
) -> Term:
    """A Term on `out` (stdout by default). Features left as None are detected from the terminal.

    The cursor is shown again at exit, whatever happens.
    """
    stream = out if out is not None else sys.stdout
    caps = detect(stream)
    has_color = caps["color"] if color is None else color
    has_unicode = caps["unicode"] if unicode is None else unicode
    term: Term = {
        "out": stream,
        "read_input": read_input if read_input is not None else input,
        "sleep": sleep,
        "color": has_color,
        "animate": (caps["animate"] if animate is None else animate) and has_color,
        "unicode": has_unicode,
        "glyphs": GLYPHS_UNICODE if has_unicode else GLYPHS_ASCII,
        "fixed_width": width,
        "rng": random.Random(seed),
        "cursor_hidden": False,
    }
    atexit.register(show_cursor, term)
    return term


def compute_width(t: Term) -> int:
    """The width to draw to: the fixed one if set, else the terminal's, kept between 40 and 100."""
    return t["fixed_width"] or max(40, min(shutil.get_terminal_size((90, 24)).columns, 100))


def write(t: Term, *, text: str) -> None:
    """Write `s` as is, with no newline, and flush."""
    try:
        t["out"].write(text)
        t["out"].flush()
    except UnicodeEncodeError:
        t["out"].write(text.encode("ascii", "replace").decode("ascii"))
        t["out"].flush()


def write_line(t: Term, *, text: str = "") -> None:
    """Write `s` and a newline."""
    write(t, text=text + "\n")


def format_styled(t: Term, *, text: str, styles: tuple[str, ...] = ()) -> str:
    """`text` wrapped in the named styles ("bold", "cyan", ...), or plain when the terminal has no color."""
    if not t["color"] or not styles:
        return text
    codes = []
    for style in styles:
        if style.isdigit():
            codes.append(f"38;5;{style}")
        else:
            codes.append(_STYLES[style])
    return f"{CSI}{';'.join(codes)}m{text}{CSI}0m"


def hide_cursor(t: Term) -> None:
    """Hide the cursor while something animates; show_cursor brings it back."""
    if t["animate"] and not t["cursor_hidden"]:
        write(t, text=HIDE_CURSOR)
        t["cursor_hidden"] = True


def show_cursor(t: Term) -> None:
    """Show the cursor again if it was hidden. Safe to call twice."""
    if not t["cursor_hidden"]:
        return
    t["cursor_hidden"] = False
    try:
        write(t, text=SHOW_CURSOR)
    except (OSError, ValueError):
        # The terminal is already gone (a closed pipe or stream), so there is no cursor to show.
        return


def sleep_briefly(t: Term, *, seconds: float) -> None:
    """Pause for `seconds`, but only when the terminal animates."""
    if t["animate"]:
        t["sleep"](seconds)

# -- text effects ----------------------------------------------------
def write_typed(t: Term, *, text: str, styles: tuple[str, ...] = (), delay: float = 0.014, end: str = "\n") -> None:
    """Print text a character at a time. Without animation: the whole line at once."""
    if not t["animate"]:
        write(t, text=format_styled(t, text=text, styles=styles) + end)
        return
    hide_cursor(t)
    try:
        for char in text:
            write(t, text=format_styled(t, text=char, styles=styles))
            t["sleep"](delay if char not in ".,;:" else delay * 6)
        write(t, text=end)
    finally:
        show_cursor(t)


def show_shimmer(t: Term, *, text: str, passes: int = 2, base: int = 244, delay: float = 0.012, indent: str = "") -> None:
    """A bright highlight sweeps across the text. Ends on the settled, colored line."""
    palette = [39, 45, 51, 87, 123, 159, 195, 231]
    settled = format_gradient(t, text=text)
    if not t["animate"]:
        write_line(t, text=indent + settled)
        return
    hide_cursor(t)
    try:
        heads = range(-len(palette), len(text) + len(palette))
        for head in [*heads] * passes:
            write(t, text="\r" + indent + _render_shimmer_frame(t, text=text, head=head, palette=palette, base=base))
            t["sleep"](delay)
        write(t, text="\r" + CLEAR_LINE + indent + settled + "\n")
    finally:
        show_cursor(t)


def _render_shimmer_frame(t: Term, *, text: str, head: int, palette: list[int], base: int) -> str:
    """The text with the highlight's bright end at position `head`, fading behind it."""
    return "".join(
        format_styled(t, text=char, styles=(str(palette[head - index]),)) if 0 <= head - index < len(palette) else format_styled(t, text=char, styles=(str(base),))
        for index, char in enumerate(text)
    )


def format_gradient(t: Term, *, text: str) -> str:
    """`text` shaded across a color gradient, or plain without color."""
    if not t["color"]:
        return text
    stops = [33, 39, 45, 51, 50, 49, 48, 47]
    count = max(1, len(text) - 1)
    return "".join(format_styled(t, text=char, styles=(str(stops[int(index / count * (len(stops) - 1))]),)) for index, char in enumerate(text))

# -- bars ----------------------------------------------------------
def render_bar(t: Term, *, frac: float, width: int = 24) -> str:
    """A progress bar `width` cells wide, filled to `frac` (0 to 1)."""
    frac = max(0.0, min(1.0, frac))
    full = int(frac * width)
    if t["unicode"]:
        partial_chars = " ▏▎▍▌▋▊▉"
        partial = partial_chars[int((frac * width - full) * 8)] if full < width else ""
        body = t["glyphs"]["bar_full"] * full + partial.strip() + t["glyphs"]["bar_empty"] * (width - full - (1 if partial.strip() else 0))
    else:
        body = t["glyphs"]["bar_full"] * full + t["glyphs"]["bar_empty"] * (width - full)
    color = _pick_bar_color(frac)
    return format_styled(t, text=body[: max(full + 1, 0)], styles=(color,)) + format_styled(t, text=body[max(full + 1, 0):], styles=("grey",)) if t["color"] else body


def show_bar_filling(t: Term, *, label: str, to: float, width: int = 24, duration: float = 0.9, suffix: Callable[[float], str] | None = None) -> None:
    """Fill a bar from 0 to `to` in place; the last frame stays on screen."""
    def render_frame(v: float) -> str:
        tail = suffix(v) if suffix else f"{v:.2f}"
        return f"{label} {render_bar(t, frac=v, width=width)} {tail}"

    if not t["animate"]:
        write_line(t, text=render_frame(to))
        return
    hide_cursor(t)
    try:
        steps = max(8, int(duration / 0.03))
        for index in range(steps + 1):
            progress = index / steps
            # Ease out.
            value = to * (1 - (1 - progress) ** 3)
            write(t, text="\r" + CLEAR_LINE + render_frame(value))
            t["sleep"](duration / steps)
        write(t, text="\n")
    finally:
        show_cursor(t)

# -- spinner ---------------------------------------------------------
@contextmanager
def show_spinner(t: Term, *, label: str, keep: bool = True) -> Iterator[Spin]:
    """A line that spins while work happens. `keep=False` erases it afterwards (waiting, not a result)."""
    spin: Spin = {
        "term": t,
        "label": label,
        "keep": keep,
        "result": None,
        "detail": "",
        "stop": threading.Event(),
        "thread": None,
        "lock": threading.Lock(),
    }
    _start_spin(spin)
    try:
        yield spin
    except BaseException:
        _stop_spin(spin, ok=False)
        raise
    else:
        _stop_spin(spin, ok=spin["result"] is not False)


def show_decode(t: Term, *, label: str, final: str, duration: float = 1.1) -> None:
    """Random hex settles, left to right, into the real value. Used for hashes."""
    hexchars = "0123456789abcdef"
    if not t["animate"]:
        write_line(t, text=f"{label} {format_styled(t, text=final, styles=('cyan',))}")
        return
    hide_cursor(t)
    try:
        steps = max(10, int(duration / 0.03))
        for index in range(steps + 1):
            locked = int(len(final) * index / steps)
            noise = "".join(t["rng"].choice(hexchars) for _ in range(len(final) - locked))
            write(t, text="\r" + CLEAR_LINE + f"{label} " + format_styled(t, text=final[:locked], styles=("cyan", "bold")) + format_styled(t, text=noise, styles=("grey",)))
            t["sleep"](duration / steps)
        write(t, text="\n")
    finally:
        show_cursor(t)

# -- layout ----------------------------------------------------------
def draw_box(t: Term, *, lines: list[str], title: str = "", style: str = "cyan", indent: str = "  ") -> None:
    """Draw `lines` inside a box, with an optional title in the top edge."""
    inner = max([len(strip_ansi(line_text)) for line_text in lines] + [len(title) + 2, 20])
    glob = t["glyphs"]
    # the rule between the corners is inner + 2 wide; the title takes " title " out of it
    top = glob["tl"] + glob["h"] + (f" {title} " if title else glob["h"]) + glob["h"] * (inner + 2 - 1 - (len(title) + 2 if title else 1)) + glob["tr"]
    write_line(t, text=indent + format_styled(t, text=top, styles=(style,)))
    for line_text in lines:
        pad = " " * (inner - len(strip_ansi(line_text)))
        write_line(t, text=indent + format_styled(t, text=glob["v"], styles=(style,)) + " " + line_text + pad + " " + format_styled(t, text=glob["v"], styles=(style,)))
    write_line(t, text=indent + format_styled(t, text=glob["bl"] + glob["h"] * (inner + 2) + glob["br"], styles=(style,)))


def draw_rule(t: Term, *, label: str = "") -> None:
    """Draw a horizontal rule across the width, with an optional label in it."""
    glob = t["glyphs"]["h"]
    text = f" {label} " if label else ""
    write_line(t, text=format_styled(t, text=glob * 2 + text + glob * max(2, compute_width(t) - len(text) - 2), styles=("grey",)))


def show_step(t: Term, *, number: int, total: int, title: str) -> None:
    """Print a step heading: progress dots for step `n` of `total`, then the title."""
    write_line(t)
    write_line(t, text=format_styled(t, text=f"{number}/{total}", styles=("grey",)) + "  " + format_styled(t, text=title, styles=("bold", "white")))


def render_dots(t: Term, *, count: int, total: int) -> str:
    """Progress dots: `n` filled out of `total`."""
    return " ".join(format_styled(t, text=t["glyphs"]["dot"], styles=("cyan",)) if index < count else format_styled(t, text=t["glyphs"]["ring"], styles=("grey",)) for index in range(total))

# -- input -----------------------------------------------------------
def ask(t: Term, *, prompt: str) -> str:
    """Ask for a line of input with `prompt` and return what was typed."""
    show_cursor(t)
    return t["read_input"](prompt)


def wait_for_continue(t: Term, *, more: str | None = None, skip_label: str | None = None) -> str:
    """Progressive disclosure gate. Returns "next" or "skip". `m` reveals the extra text."""
    hints = [f"Enter {t['glyphs']['arrow']} continue"]
    if more:
        hints.append("m for more")
    if skip_label:
        hints.append(f"s to {skip_label}")
    shown_more = False
    while True:
        try:
            raw = ask(t, prompt=format_styled(t, text=f"  {t['glyphs']['next']} " + "  ·  ".join(hints) + " ", styles=("grey",))).strip().lower()
        except EOFError:
            return "next"
        if raw in ("", "n", "next"):
            return "next"
        if raw in ("s", "skip") and skip_label:
            return "skip"
        if raw in ("m", "more") and more and not shown_more:
            shown_more = True
            hints = [hint for hint in hints if hint != "m for more"]
            _show_more(t, more=more)
        else:
            write_line(t, text=format_styled(t, text="    (press Enter to go on)", styles=("grey",)))


def _show_more(t: Term, *, more: str) -> None:
    """The extra text `m` reveals, indented and grey, then a blank line."""
    for line in more.splitlines():
        write_line(t, text="    " + format_styled(t, text=line, styles=("grey",)))
    write_line(t)


def ask_yes_no(t: Term, *, question: str, default: bool = True) -> bool:
    """Ask a yes/no question; Enter takes `default`."""
    suffix = "[Y/n]" if default else "[y/N]"
    try:
        raw = ask(t, prompt=f"  {format_styled(t, text='?', styles=('cyan', 'bold'))} {question} {format_styled(t, text=suffix, styles=('grey',))} ").strip().lower()
    except EOFError:
        return default
    if raw == "":
        return default
    return raw[0] == "y"


# One line that spins while work happens, then settles to a check or a cross.
# `result` is None until the work calls set_spin_result; the lock guards label and detail,
# which the spinning thread reads while the work updates them.
Spin = TypedDict(
    "Spin",
    {
        "term": Term,
        "label": str,
        "keep": bool,
        "result": bool | None,
        "detail": str,
        "stop": threading.Event,
        "thread": threading.Thread | None,
        "lock": threading.Lock,
    },
)


def _start_spin(spin: Spin) -> None:
    """Print the line, and if the terminal animates, spin it on a background thread."""
    t = spin["term"]
    if not t["animate"]:
        write_line(t, text=f"  {t['glyphs']['next']} {spin['label']} ...")
        return
    hide_cursor(t)
    frames = itertools.cycle(t["glyphs"]["spin"])

    def run() -> None:
        while not spin["stop"].is_set():
            with spin["lock"]:
                detail = format_styled(t, text=f"  {spin['detail']}", styles=("grey",)) if spin["detail"] else ""
                write(t, text="\r" + CLEAR_LINE + f"  {format_styled(t, text=next(frames), styles=('cyan',))} {spin['label']}" + detail)
            time.sleep(0.08)

    thread = threading.Thread(target=run, daemon=True)
    spin["thread"] = thread
    thread.start()


def update_spin(spin: Spin, *, label: str | None = None, detail: str | None = None) -> None:
    """Change what the spinning line says while it spins."""
    with spin["lock"]:
        if label is not None:
            spin["label"] = label
        if detail is not None:
            spin["detail"] = detail


def set_spin_result(spin: Spin, *, ok: bool, note: str = "") -> None:
    """Record how the work went, so the line settles to a check (ok) or a cross, with `note` after it."""
    spin["result"], spin["detail"] = ok, note


def _stop_spin(spin: Spin, *, ok: bool) -> None:
    """Stop spinning and settle the line, or erase it if it was only a wait."""
    t, thread = spin["term"], spin["thread"]
    if thread:
        spin["stop"].set()
        thread.join(timeout=1)
    if not spin["keep"] and ok:
        if thread:
            # Transient: leave no trace of the wait.
            write(t, text="\r" + CLEAR_LINE)
        show_cursor(t)
        return
    if ok:
        mark = format_styled(t, text=t["glyphs"]["ok"], styles=("green", "bold"))
    else:
        mark = format_styled(t, text=t["glyphs"]["bad"], styles=("red", "bold"))
    tail = format_styled(t, text=f"  {spin['detail']}", styles=("grey",)) if spin["detail"] else ""
    write(t, text=("\r" + CLEAR_LINE if thread else "") + f"  {mark} {spin['label']}{tail}\n")
    show_cursor(t)
