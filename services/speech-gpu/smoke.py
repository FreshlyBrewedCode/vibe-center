#!/usr/bin/env python3
"""End-to-end smoke test from dev, through the tunnels (stdlib only):
TTS (8402) synthesizes a sentence -> 16 kHz WAV -> STT (8401) -> transcript, with timings.
usage: ./smoke.py [--text "..."] [--voice af_heart] [--save out.wav] [--host 127.0.0.1]"""
import argparse, array, http.client, io, json, re, sys, time, uuid, wave

p = argparse.ArgumentParser()
p.add_argument("--text", default="Hi Karl, the build for the vibe center repo passed. "
                                 "Should I open the pull request and ping the reviewers?")
p.add_argument("--voice", default="af_heart")
p.add_argument("--save", help="also write the synthesized audio (24 kHz WAV) here")
p.add_argument("--host", default="127.0.0.1")
a = p.parse_args()


def get(port, path):
    c = http.client.HTTPConnection(a.host, port, timeout=10)
    c.request("GET", path); r = c.getresponse()
    return r.status, r.read()


for port in (8401, 8402):
    try:
        status, _ = get(port, "/health")
    except OSError as e:
        sys.exit(f"{a.host}:{port} not reachable ({e}); run ./speech.sh up")
    if status != 200:
        sys.exit(f"{a.host}:{port}/health -> {status}")

# TTS, streamed
c = http.client.HTTPConnection(a.host, 8402, timeout=60)
body = json.dumps({"input": a.text, "voice": a.voice, "response_format": "pcm"})
t0 = time.perf_counter()
c.request("POST", "/v1/audio/speech", body, {"Content-Type": "application/json"})
r = c.getresponse()
if r.status != 200:
    sys.exit(f"TTS -> {r.status}: {r.read()[:300]!r}")
pcm = bytearray(); ttfa = None; n_chunks = 0
while True:
    chunk = r.read1(65536)
    if not chunk:
        break
    if ttfa is None:
        ttfa = time.perf_counter() - t0
    pcm += chunk; n_chunks += 1
tts_total = time.perf_counter() - t0
sr = int(r.getheader("X-Sample-Rate", "24000"))
pcm24 = array.array("h", bytes(pcm[: len(pcm) // 2 * 2]))
dur = len(pcm24) / sr
print(f"TTS  {len(a.text.split())} words, voice {a.voice}: first audio {ttfa*1000:.0f} ms, "
      f"{dur:.2f}s audio in {tts_total*1000:.0f} ms ({n_chunks} reads), RTF {tts_total/dur:.3f}")
# the server trims each sentence's padding (~30 ms lead, ~120 ms tail); untrimmed it was ~350/500
first = next((i for i, v in enumerate(pcm24) if abs(v) > 330), len(pcm24))
last = next((i for i in range(len(pcm24) - 1, -1, -1) if abs(pcm24[i]) > 330), 0)
lead_ms, tail_ms = first / sr * 1000, (len(pcm24) - 1 - last) / sr * 1000
print(f"TTS  silence: {lead_ms:.0f} ms before the first sound, {tail_ms:.0f} ms after the last")

if a.save:
    with wave.open(a.save, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr); w.writeframes(pcm24.tobytes())

# 24 kHz -> 16 kHz (linear interpolation; plenty for a smoke test), as a pipeline would send it
n16 = int(len(pcm24) * 16000 / sr)
pcm16 = array.array("h", bytes(2 * n16))
for i in range(n16):
    x = i * sr / 16000; j = int(x); f = x - j
    nxt = pcm24[j + 1] if j + 1 < len(pcm24) else pcm24[j]
    pcm16[i] = int(pcm24[j] * (1 - f) + nxt * f)
buf = io.BytesIO()
with wave.open(buf, "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(pcm16.tobytes())

# STT, multipart
boundary = uuid.uuid4().hex
parts = [f'--{boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nparakeet\r\n'.encode(),
         f'--{boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nen\r\n'.encode(),
         f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="utt.wav"\r\n'
         f'Content-Type: audio/wav\r\n\r\n'.encode() + buf.getvalue() + b"\r\n",
         f"--{boundary}--\r\n".encode()]
c = http.client.HTTPConnection(a.host, 8401, timeout=60)
t0 = time.perf_counter()
c.request("POST", "/v1/audio/transcriptions", b"".join(parts),
          {"Content-Type": f"multipart/form-data; boundary={boundary}"})
r = c.getresponse(); resp = r.read()
stt_total = time.perf_counter() - t0
if r.status != 200:
    sys.exit(f"STT -> {r.status}: {resp[:300]!r}")
text = json.loads(resp)["text"]
print(f"STT  {dur:.2f}s audio: {stt_total*1000:.0f} ms round trip "
      f"({float(r.getheader('X-Processing-Ms', 'nan')):.0f} ms in the server)")
print(f"sent:  {a.text}\nheard: {text}")

words = lambda s: re.sub(r"[^a-z0-9 ]", " ", s.lower()).split()
ref, hyp = words(a.text), words(text)
missing = [w for w in ref if w not in hyp]
ok = len(missing) <= max(1, len(ref) // 10)
padded = lead_ms > 100 or tail_ms > 250
print("PASS" if ok and not padded else
      f"FAIL: missing words {missing}" if not ok else f"FAIL: untrimmed silence ({lead_ms:.0f}/{tail_ms:.0f} ms)")
ok = ok and not padded
sys.exit(0 if ok else 1)
