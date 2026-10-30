"""Shared bits of the servers: logging."""
import logging, sys

logging.basicConfig(stream=sys.stdout, level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s")
for noisy in ("httpx", "huggingface_hub", "filelock"):
    logging.getLogger(noisy).setLevel(logging.WARNING)
