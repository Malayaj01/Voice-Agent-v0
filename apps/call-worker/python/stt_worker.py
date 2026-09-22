"""faster-whisper sidecar for the call worker.

Transcription ONLY. Endpoint detection lives in the Node process (see vad.ts): it is the
event that starts the §6 turn clock, so putting a pipe in front of it would spend the budget
it exists to measure. By the time audio reaches this script the endpoint has already fired
and the caller is waiting — everything here is counted as t_stt_ms.

Protocol: one JSON object per line on stdin, one per line on stdout.

  in   {"id": 1, "op": "load"}
  in   {"id": 2, "op": "transcribe", "pcm": "<base64 s16le>", "rate": 16000,
        "lang": "en", "prompt": "..." , "partial": true}
  in   {"id": 3, "op": "shutdown"}

  out  {"id": 1, "ok": true, "event": "loaded", "model": "...", "ms": 1234}
  out  {"id": 2, "ok": true, "event": "transcript", "text": "...", "ms": 210}
  out  {"id": N, "ok": false, "error": "..."}

Base64 rather than raw binary on stdin: mixing a length-prefixed binary stream with JSON
lines is where cross-platform pipe handling goes wrong, and a scripted line is a few KB. If
this ever carries continuous audio it should become a socket with a framed binary protocol.
"""

from __future__ import annotations

import base64
import json
import os
import sys
import time

import numpy as np

_model = None
_model_name = ""


def _emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _load(req_id: int) -> None:
    global _model, _model_name
    from faster_whisper import WhisperModel

    _model_name = os.environ.get("STT_MODEL", "distil-small.en")
    device = os.environ.get("STT_DEVICE", "cpu")
    # int8 is the CPU-sane quantisation; float32 roughly doubles memory for no accuracy that
    # survives a phone line.
    compute_type = os.environ.get("STT_COMPUTE_TYPE", "int8")

    started = time.perf_counter()
    _model = WhisperModel(_model_name, device=device, compute_type=compute_type)
    _emit(
        {
            "id": req_id,
            "ok": True,
            "event": "loaded",
            "model": _model_name,
            "device": device,
            "compute_type": compute_type,
            "ms": round((time.perf_counter() - started) * 1000, 1),
        }
    )


def _dedupe(text: str) -> str:
    """Drops a transcript that is the same phrase repeated.

    The thresholds above catch most of it, but a short loop like "Hello. Hello. Hello."
    compresses poorly enough to survive. A caller does not say the same sentence four times,
    so treating that as silence is safer than feeding it to the classifier.
    """
    parts = [p.strip() for p in text.replace("!", ".").replace("?", ".").split(".") if p.strip()]
    if len(parts) >= 3 and len(set(p.lower() for p in parts)) == 1:
        return ""
    return text


def _transcribe(req: dict) -> None:
    if _model is None:
        raise RuntimeError("model not loaded")

    pcm = np.frombuffer(base64.b64decode(req["pcm"]), dtype="<i2")
    audio = pcm.astype(np.float32) / 32768.0

    is_partial = bool(req.get("partial", False))
    lang = req.get("lang") or None
    # English-only builds (distil-*.en) reject an explicit language argument.
    if _model_name.endswith(".en"):
        lang = None

    started = time.perf_counter()
    segments, _info = _model.transcribe(
        audio,
        language=lang,
        # A partial is a throwaway guess that a later partial overwrites, so it is not worth
        # beam search; the final transcript is what the FSM branches on.
        beam_size=1 if is_partial else 5,
        # The VAD upstream already decided what is speech. Running another one here would
        # second-guess the component whose timing the whole §6 budget is built around.
        vad_filter=False,
        # Whisper will happily continue a previous hallucination if allowed to see it.
        condition_on_previous_text=False,
        # Hallucination guards. Handed a segment of room noise, Whisper invents fluent text
        # and often loops it: "We can't do that. We can't do that. We can't do that." Observed
        # on live microphone audio, where it reached the FSM as a real utterance.
        # compression_ratio catches the looping, no_speech/log_prob catch the inventing.
        compression_ratio_threshold=2.4,
        log_prob_threshold=-1.0,
        no_speech_threshold=0.6,
        initial_prompt=req.get("prompt") or None,
    )

    kept = [s for s in segments if getattr(s, "no_speech_prob", 0.0) < 0.6]
    text = _dedupe("".join(segment.text for segment in kept).strip())

    _emit(
        {
            "id": req["id"],
            "ok": True,
            "event": "transcript",
            "text": text,
            "partial": is_partial,
            "ms": round((time.perf_counter() - started) * 1000, 1),
        }
    )


def main() -> int:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            req = json.loads(line)
        except json.JSONDecodeError as err:
            _emit({"id": 0, "ok": False, "error": f"bad json: {err}"})
            continue

        op = req.get("op")
        req_id = req.get("id", 0)
        try:
            if op == "load":
                _load(req_id)
            elif op == "transcribe":
                _transcribe(req)
            elif op == "shutdown":
                return 0
            else:
                _emit({"id": req_id, "ok": False, "error": f"unknown op {op!r}"})
        except Exception as err:  # noqa: BLE001 - a bad request must not kill the sidecar
            _emit({"id": req_id, "ok": False, "error": f"{type(err).__name__}: {err}"})

    return 0


if __name__ == "__main__":
    sys.exit(main())
