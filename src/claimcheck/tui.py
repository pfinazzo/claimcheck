"""A small terminal toolkit: color, typewriter text, shimmer, progress bars, spinners, decode effects.

Standard library only. Everything degrades on its own: with no terminal, NO_COLOR, TERM=dumb or CI
set, animations are replaced by their final frame and colors by plain text, so scripts and logs stay
clean. Output, input and sleep are injectable so the whole thing can be tested without a console.

@author Patrick Finazzo
"""

from __future__ import annotations

import atexit
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
    return ANSI.sub("", s)


def enable_windows_vt() -> None:
    """Turn on ANSI escape handling in the classic Windows console. Harmless elsewhere."""
    if os.name != "nt":
        return
    try:
        import ctypes

        k = ctypes.windll.kernel32  # type: ignore[attr-defined]
        for std in (-11, -12):  # stdout, stderr
            h = k.GetStdHandle(std)
            mode = ctypes.c_uint32()
            if k.GetConsoleMode(h, ctypes.byref(mode)):
                k.SetConsoleMode(h, mode.value | 0x0004)
    except (AttributeError, OSError):
        # An old console without these calls keeps its default mode. The text still prints;
        # only the colors show up as escape codes.
        return


def detect(stream=None, env: Mapping[str, str] | None = None) -> dict:
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


class Term:
    def __init__(
        self,
        out=None,
        inp: Callable[[str], str] | None = None,
        *,
        animate: bool | None = None,
        color: bool | None = None,
        unicode: bool | None = None,
        sleep: Callable[[float], None] = time.sleep,
        width: int | None = None,
        seed: int | None = None,
    ):
        self.out = out if out is not None else sys.stdout
        caps = detect(self.out)
        self.color = caps["color"] if color is None else color
        self.animate = (caps["animate"] if animate is None else animate) and self.color
        self.unicode = caps["unicode"] if unicode is None else unicode
        self.g = GLYPHS_UNICODE if self.unicode else GLYPHS_ASCII
        self.inp = inp if inp is not None else input
        self.sleep = sleep
        self._width = width
        self.rng = random.Random(seed)
        self._cursor_hidden = False
        atexit.register(self.restore)

    # -- basics --------------------------------------------------------
    @property
    def width(self) -> int:
        return self._width or max(40, min(shutil.get_terminal_size((90, 24)).columns, 100))

    def w(self, s: str) -> None:
        try:
            self.out.write(s)
            self.out.flush()
        except UnicodeEncodeError:
            self.out.write(s.encode("ascii", "replace").decode("ascii"))
            self.out.flush()

    def p(self, s: str = "") -> None:
        self.w(s + "\n")

    def c(self, text: str, *names: str) -> str:
        if not self.color or not names:
            return text
        codes = []
        for n in names:
            if n.isdigit():
                codes.append(f"38;5;{n}")
            else:
                codes.append(_STYLES[n])
        return f"{CSI}{';'.join(codes)}m{text}{CSI}0m"

    def hide_cursor(self) -> None:
        if self.animate and not self._cursor_hidden:
            self.w(HIDE_CURSOR)
            self._cursor_hidden = True

    def restore(self) -> None:
        if not self._cursor_hidden:
            return
        self._cursor_hidden = False
        try:
            self.w(SHOW_CURSOR)
        except (OSError, ValueError):
            # The terminal is already gone (a closed pipe or stream), so there is no cursor to show.
            return

    def nap(self, seconds: float) -> None:
        if self.animate:
            self.sleep(seconds)

    # -- text effects ----------------------------------------------------
    def typewriter(self, text: str, *styles: str, delay: float = 0.014, end: str = "\n") -> None:
        """Print text a character at a time. Without animation: the whole line at once."""
        if not self.animate:
            self.w(self.c(text, *styles) + end)
            return
        self.hide_cursor()
        try:
            for ch in text:
                self.w(self.c(ch, *styles))
                self.sleep(delay if ch not in ".,;:" else delay * 6)
            self.w(end)
        finally:
            self.restore()

    def shimmer(self, text: str, *, passes: int = 2, base: int = 244, delay: float = 0.012, indent: str = "") -> None:
        """A bright highlight sweeps across the text. Ends on the settled, colored line."""
        palette = [39, 45, 51, 87, 123, 159, 195, 231]
        settled = self.gradient(text)
        if not self.animate:
            self.p(indent + settled)
            return
        self.hide_cursor()
        try:
            n = len(text)
            for _ in range(passes):
                for head in range(-len(palette), n + len(palette)):
                    line = []
                    for i, ch in enumerate(text):
                        d = head - i
                        line.append(self.c(ch, str(palette[d])) if 0 <= d < len(palette) else self.c(ch, str(base)))
                    self.w("\r" + indent + "".join(line))
                    self.sleep(delay)
            self.w("\r" + CLEAR_LINE + indent + settled + "\n")
        finally:
            self.restore()

    def gradient(self, text: str) -> str:
        if not self.color:
            return text
        stops = [33, 39, 45, 51, 50, 49, 48, 47]
        n = max(1, len(text) - 1)
        return "".join(self.c(ch, str(stops[int(i / n * (len(stops) - 1))])) for i, ch in enumerate(text))

    # -- bars ----------------------------------------------------------
    def bar(self, frac: float, width: int = 24) -> str:
        frac = max(0.0, min(1.0, frac))
        full = int(frac * width)
        if self.unicode:
            partial_chars = " ▏▎▍▌▋▊▉"
            partial = partial_chars[int((frac * width - full) * 8)] if full < width else ""
            body = self.g["bar_full"] * full + partial.strip() + self.g["bar_empty"] * (width - full - (1 if partial.strip() else 0))
        else:
            body = self.g["bar_full"] * full + self.g["bar_empty"] * (width - full)
        color = "green" if frac >= 0.7 else "yellow" if frac >= 0.4 else "red"
        return self.c(body[: max(full + 1, 0)], color) + self.c(body[max(full + 1, 0):], "grey") if self.color else body

    def animate_bar(self, label: str, to: float, *, width: int = 24, duration: float = 0.9, suffix: Callable[[float], str] | None = None) -> None:
        """Fill a bar from 0 to `to` in place; the last frame stays on screen."""
        def frame(v: float) -> str:
            tail = suffix(v) if suffix else f"{v:.2f}"
            return f"{label} {self.bar(v, width)} {tail}"

        if not self.animate:
            self.p(frame(to))
            return
        self.hide_cursor()
        try:
            steps = max(8, int(duration / 0.03))
            for i in range(steps + 1):
                t = i / steps
                v = to * (1 - (1 - t) ** 3)  # ease out
                self.w("\r" + CLEAR_LINE + frame(v))
                self.sleep(duration / steps)
            self.w("\n")
        finally:
            self.restore()

    # -- spinner ---------------------------------------------------------
    @contextmanager
    def spinner(self, label: str, *, keep: bool = True) -> Iterator[_Spin]:
        """A line that spins while work happens. `keep=False` erases it afterwards (waiting, not a result)."""
        spin = _Spin(self, label, keep=keep)
        spin.start()
        try:
            yield spin
        except BaseException:
            spin.stop(ok=False)
            raise
        else:
            spin.stop(ok=spin.result is not False)

    def decode(self, label: str, final: str, *, duration: float = 1.1) -> None:
        """Random hex settles, left to right, into the real value. Used for hashes."""
        hexchars = "0123456789abcdef"
        if not self.animate:
            self.p(f"{label} {self.c(final, 'cyan')}")
            return
        self.hide_cursor()
        try:
            steps = max(10, int(duration / 0.03))
            for i in range(steps + 1):
                locked = int(len(final) * i / steps)
                noise = "".join(self.rng.choice(hexchars) for _ in range(len(final) - locked))
                self.w("\r" + CLEAR_LINE + f"{label} " + self.c(final[:locked], "cyan", "bold") + self.c(noise, "grey"))
                self.sleep(duration / steps)
            self.w("\n")
        finally:
            self.restore()

    # -- layout ----------------------------------------------------------
    def box(self, lines: list[str], *, title: str = "", style: str = "cyan", indent: str = "  ") -> None:
        inner = max([len(strip_ansi(line_text)) for line_text in lines] + [len(title) + 2, 20])
        g = self.g
        # the rule between the corners is inner + 2 wide; the title takes " title " out of it
        top = g["tl"] + g["h"] + (f" {title} " if title else g["h"]) + g["h"] * (inner + 2 - 1 - (len(title) + 2 if title else 1)) + g["tr"]
        self.p(indent + self.c(top, style))
        for line_text in lines:
            pad = " " * (inner - len(strip_ansi(line_text)))
            self.p(indent + self.c(g["v"], style) + " " + line_text + pad + " " + self.c(g["v"], style))
        self.p(indent + self.c(g["bl"] + g["h"] * (inner + 2) + g["br"], style))

    def rule(self, label: str = "") -> None:
        g = self.g["h"]
        text = f" {label} " if label else ""
        self.p(self.c(g * 2 + text + g * max(2, self.width - len(text) - 2), "grey"))

    def step(self, n: int, total: int, title: str) -> None:
        self.p()
        self.p(self.c(f"{n}/{total}", "grey") + "  " + self.c(title, "bold", "white"))

    def dots(self, n: int, total: int) -> str:
        return " ".join(self.c(self.g["dot"], "cyan") if i < n else self.c(self.g["ring"], "grey") for i in range(total))

    # -- input -----------------------------------------------------------
    def ask(self, prompt: str) -> str:
        self.restore()
        return self.inp(prompt)

    def pause(self, *, more: str | None = None, skip_label: str | None = None) -> str:
        """Progressive disclosure gate. Returns "next" or "skip". `m` reveals the extra text."""
        hints = [f"Enter {self.g['arrow']} continue"]
        if more:
            hints.append("m for more")
        if skip_label:
            hints.append(f"s to {skip_label}")
        shown_more = False
        while True:
            try:
                raw = self.ask(self.c(f"  {self.g['next']} " + "  ·  ".join(hints) + " ", "grey")).strip().lower()
            except EOFError:
                return "next"
            if raw in ("", "n", "next"):
                return "next"
            if raw in ("s", "skip") and skip_label:
                return "skip"
            if raw in ("m", "more") and more and not shown_more:
                shown_more = True
                hints = [h for h in hints if h != "m for more"]
                for line in more.splitlines():
                    self.p("    " + self.c(line, "grey"))
                self.p()
            else:
                self.p(self.c("    (press Enter to go on)", "grey"))

    def yes_no(self, question: str, *, default: bool = True) -> bool:
        suffix = "[Y/n]" if default else "[y/N]"
        try:
            raw = self.ask(f"  {self.c('?', 'cyan', 'bold')} {question} {self.c(suffix, 'grey')} ").strip().lower()
        except EOFError:
            return default
        if raw == "":
            return default
        return raw[0] == "y"


class _Spin:
    """One line that spins while work happens, then settles to a check or a cross."""

    def __init__(self, term: Term, label: str, keep: bool = True):
        self.t, self.label, self.keep = term, label, keep
        self.result: bool | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()
        self.detail = ""

    def start(self) -> None:
        if not self.t.animate:
            self.t.p(f"  {self.t.g['next']} {self.label} ...")
            return
        self.t.hide_cursor()
        frames = itertools.cycle(self.t.g["spin"])

        def run() -> None:
            while not self._stop.is_set():
                with self._lock:
                    self.t.w("\r" + CLEAR_LINE + f"  {self.t.c(next(frames), 'cyan')} {self.label}" + (self.t.c(f"  {self.detail}", "grey") if self.detail else ""))
                time.sleep(0.08)

        self._thread = threading.Thread(target=run, daemon=True)
        self._thread.start()

    def update(self, label: str | None = None, detail: str | None = None) -> None:
        with self._lock:
            if label is not None:
                self.label = label
            if detail is not None:
                self.detail = detail

    def ok(self, note: str = "") -> None:
        self.result, self.detail = True, note

    def fail(self, note: str = "") -> None:
        self.result, self.detail = False, note

    def stop(self, *, ok: bool) -> None:
        if self._thread:
            self._stop.set()
            self._thread.join(timeout=1)
        if not self.keep and ok:
            if self._thread:
                self.t.w("\r" + CLEAR_LINE)  # transient: leave no trace of the wait
            self.t.restore()
            return
        mark = self.t.c(self.t.g["ok"], "green", "bold") if ok else self.t.c(self.t.g["bad"], "red", "bold")
        tail = self.t.c(f"  {self.detail}", "grey") if self.detail else ""
        self.t.w(("\r" + CLEAR_LINE if self._thread else "") + f"  {mark} {self.label}{tail}\n")
        self.t.restore()
