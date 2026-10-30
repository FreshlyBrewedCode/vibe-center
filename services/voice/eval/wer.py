"""Word error rate with a normalizer for spoken commands: case, punctuation, and numbers either
way ("PR42", "PR forty two" and "PR 42" all read "pr 42"; "seven eight eight zero" is "7880")."""

from __future__ import annotations

import re

UNITS = {
    w: i
    for i, w in enumerate(
        "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen "
        "sixteen seventeen eighteen nineteen".split()
    )
}
TENS = {
    w: 10 * i
    for i, w in enumerate("_ _ twenty thirty forty fifty sixty seventy eighty ninety".split())
    if i > 1
}
SCALES = {"hundred": 100, "thousand": 1000}
SAME = {"ok": "okay", "alright": "all right", "gonna": "going to", "wanna": "want to"}


def _numbers(words: list[str]) -> list[str]:
    out: list[str] = []
    i = 0
    while i < len(words):
        w = words[i]
        # a run of single digits is read digit by digit: "seven eight eight zero" -> 7880
        if w in UNITS and UNITS[w] < 10:
            j = i
            while j < len(words) and words[j] in UNITS and UNITS[words[j]] < 10:
                j += 1
            if j - i > 1:
                out.append("".join(str(UNITS[x]) for x in words[i:j]))
                i = j
                continue
        if w in UNITS or w in TENS:
            total, cur, j = 0, 0, i
            while j < len(words):
                x = words[j]
                # "three thirty" is two numbers, "thirty three" one
                if x in UNITS and cur % 10 == 0 and not 0 < cur % 100 < 20:
                    cur += UNITS[x]
                elif x in TENS and cur % 100 == 0:
                    cur += TENS[x]
                elif j == i and x in UNITS:
                    cur = UNITS[x]
                elif x in SCALES and cur:
                    if SCALES[x] == 100:
                        cur *= 100
                    else:
                        total, cur = total + cur * SCALES[x], 0
                elif (
                    x == "and"
                    and j + 1 < len(words)
                    and (words[j + 1] in UNITS or words[j + 1] in TENS)
                    and cur >= 100
                ):
                    pass
                else:
                    break
                j += 1
            out.append(str(total + cur))
            i = j
            continue
        out.append(w)
        i += 1
    return out


def normalize(text: str) -> list[str]:
    t = text.lower().replace("%", " percent").replace("&", " and ")
    t = re.sub(r"(?<=\d),(?=\d{3})", "", t)  # 1,000
    t = re.sub(r"(?<=[a-z])(?=\d)|(?<=\d)(?=[a-z])", " ", t)  # pr42 -> pr 42
    t = t.replace("'", "").replace("’", "")
    t = re.sub(r"[^a-z0-9]+", " ", t)
    words = []
    for w in t.split():
        words += SAME.get(w, w).split()
    return _numbers(words)


def edits(ref: list[str], hyp: list[str]) -> int:
    prev = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, 1):
        cur = [i] + [0] * len(hyp)
        for j, h in enumerate(hyp, 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r != h))
        prev = cur
    return prev[-1]


def wer(pairs: list[tuple[str, str]]) -> float:
    """Corpus WER over (reference, hypothesis) pairs."""
    errors = words = 0
    for ref, hyp in pairs:
        r = normalize(ref)
        errors += edits(r, normalize(hyp))
        words += len(r)
    return errors / max(words, 1)
