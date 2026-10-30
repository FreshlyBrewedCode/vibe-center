"""Stand-ins for fetch.py, the runtime setup and stt_backend.py, with the same stdout protocol.

    fake_steps.py fetch <dir> [fail|slow]     writes 3 x 100 kB, printing `total`, then `phase convert`
    fake_steps.py runtime <dir>               creates the runtime directory
    fake_steps.py backend <model-id> [fail]   answers every request with the model id and the prompt
"""
import json, os, sys, time

cmd = sys.argv[1]
if cmd == "fetch":
    d, mode = sys.argv[2], (sys.argv[3] if len(sys.argv) > 3 else "")
    os.makedirs(d, exist_ok=True)
    print("total 300000", flush=True)
    for i in range(3):
        with open(os.path.join(d, f"part{i}"), "wb") as f:
            f.write(b"\0" * 100_000)
        time.sleep(1.0 if mode == "slow" else 0.05)
        if mode == "fail":
            print("HTTP 404: no such repo", flush=True)
            sys.exit(1)
    print("phase convert", flush=True)
elif cmd == "runtime":
    os.makedirs(sys.argv[2], exist_ok=True)
    open(os.path.join(sys.argv[2], "lib"), "w").write("x" * 1000)
elif cmd == "backend":
    mid = sys.argv[2]
    if len(sys.argv) > 3 and sys.argv[3] == "fail":
        print(json.dumps({"error": "CUDA out of memory"}), flush=True)
        sys.exit(1)
    print(json.dumps({"ready": True, "model": mid}), flush=True)
    stdin = sys.stdin.buffer
    while head := stdin.readline():
        req = json.loads(head)
        stdin.read(req["n"] * 4)
        text = f"{mid} heard {req['n']} samples" + (f" with {req['prompt']}" if req.get("prompt") else "")
        print(json.dumps({"text": text, "ms": 1.0}), flush=True)
