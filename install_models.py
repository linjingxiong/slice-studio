"""Download the pinned MobileSAM ONNX exports and verify their SHA-256 digests."""

from hashlib import file_digest, sha256
from pathlib import Path
from tempfile import NamedTemporaryFile
from urllib.request import urlopen

from neural import FILES, MODELS

ORIGIN = "https://huggingface.co/Acly/MobileSAM/resolve/0d3b403/"


def download(name, expected_size, expected_hash):
    target = MODELS / name
    if target.is_file() and target.stat().st_size == expected_size:
        with target.open("rb") as existing:
            if file_digest(existing, "sha256").hexdigest() == expected_hash:
                print(f"{name} verified", flush=True)
                return
    print(f"Downloading {name} ({expected_size / 1_048_576:.1f} MiB)…", flush=True)
    digest = sha256()
    size = 0
    with NamedTemporaryFile(dir=MODELS, suffix=".part", delete=False) as staging:
        temporary = Path(staging.name)
        try:
            with urlopen(ORIGIN + name, timeout=60) as stream:
                while chunk := stream.read(1024 * 1024):
                    size += len(chunk)
                    if size > expected_size:
                        raise RuntimeError(f"Unexpected download size for {name}")
                    digest.update(chunk)
                    staging.write(chunk)
            if size != expected_size or digest.hexdigest() != expected_hash:
                raise RuntimeError(f"SHA-256 verification failed for {name}")
            staging.close()
            temporary.replace(target)
        finally:
            staging.close()
            temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    MODELS.mkdir(exist_ok=True)
    for model, (size, checksum) in FILES.items():
        download(model, size, checksum)
