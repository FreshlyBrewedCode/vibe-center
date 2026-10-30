#!/usr/bin/env python3
"""Latency of the running servers as a conversation would see it: requests spaced by a
pause (the GPU clocks down in between), measured from dev through the tunnels. stdlib only.
usage: bench/paced.py [gap_seconds=2] [reps=7]"""
import http.client, io, json, statistics, sys, time, uuid, wave

GAP = float(sys.argv[1]) if len(sys.argv) > 1 else 2.0
REPS = int(sys.argv[2]) if len(sys.argv) > 2 else 7
TTS = {"short": "Sure, I will check the build and get back to you.",
       "medium": "I looked at the failing test in the payments service. The mock returns an empty list, "
                 "so the retry loop never ends. I can patch it and open a pull request, if you like."}
UTT = {"1s": "Yes, merge it.", "3s": "Open a pull request for the vibe center repo.",
       "8s": "Check the CI status on PR forty two, and if the tests pass, ask the agent to rebase the "
             "branch and run the CLI smoke test again."}

def tts(text, voice="af_heart"):
    c = http.client.HTTPConnection("127.0.0.1", 8402, timeout=60)
    t0 = time.perf_counter()
    c.request("POST", "/v1/audio/speech", json.dumps({"input": text, "voice": voice}), {"Content-Type": "application/json"})
    r = c.getresponse(); pcm = bytearray(); first = None
    while chunk := r.read1(65536):
        first = first or time.perf_counter() - t0; pcm += chunk
    return first * 1000, (time.perf_counter() - t0) * 1000, bytes(pcm)

def wav16(pcm24):
    import array
    s = array.array("h", pcm24); n = len(s) * 2 // 3
    out = array.array("h", (s[i * 3 // 2] for i in range(n)))  # nearest-neighbour 24k -> 16k
    b = io.BytesIO()
    with wave.open(b, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(out.tobytes())
    return b.getvalue(), n / 16000

def stt(wav):
    bd = uuid.uuid4().hex
    # language=en as the voice worker sends it (a multilingual Whisper would detect it otherwise)
    body = (f'--{bd}\r\nContent-Disposition: form-data; name="language"\r\n\r\nen\r\n'
            f'--{bd}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\n\r\n'.encode()
            + wav + f"\r\n--{bd}--\r\n".encode())
    c = http.client.HTTPConnection("127.0.0.1", 8401, timeout=60)
    t0 = time.perf_counter()
    c.request("POST", "/v1/audio/transcriptions", body, {"Content-Type": f"multipart/form-data; boundary={bd}"})
    r = c.getresponse(); txt = json.loads(r.read())["text"]
    return (time.perf_counter() - t0) * 1000, float(r.getheader("X-Processing-Ms")), txt

med = statistics.median
print(f"gap {GAP}s between requests, median of {REPS}")
for k, text in TTS.items():
    runs = []
    for _ in range(REPS):
        time.sleep(GAP); runs.append(tts(text))
    dur = len(runs[0][2]) / 2 / 24000
    print(f"TTS {k:6s} {len(text.split()):2d} words {dur:5.2f}s: first audio {med(r[0] for r in runs):4.0f} ms, "
          f"all {med(r[1] for r in runs):4.0f} ms, RTF {med(r[1] for r in runs) / 1000 / dur:.3f}")
for k, text in UTT.items():
    wav, dur = wav16(tts(text)[2])
    runs = []
    for _ in range(REPS):
        time.sleep(GAP); runs.append(stt(wav))
    print(f"STT {k:3s} {dur:5.2f}s: server {med(r[1] for r in runs):4.0f} ms, round trip {med(r[0] for r in runs):4.0f} ms | {runs[0][2]}")
