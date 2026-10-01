#!/usr/bin/env python3
"""Transcribes a vocal stem with timestamps. Runs inside .venv (faster-whisper or openai-whisper).

Usage: lyrics_worker.py <audio> <out.json>
Model: env NEARFIELD_WHISPER (default "small"; "medium"/"large-v3" are more accurate, slower).
"""

from __future__ import annotations

import json
import os
import sys


def transcribe_faster(path: str, model_name: str) -> dict:
    from faster_whisper import WhisperModel

    model = WhisperModel(model_name, device="auto", compute_type="int8")
    segments, info = model.transcribe(path, word_timestamps=True, vad_filter=True, beam_size=5)
    result = []
    for seg in segments:
        # Whisper invents text over instrumental gaps; drop segments it is not sure contain speech.
        if seg.no_speech_prob > 0.6 or not seg.text.strip():
            continue
        result.append({
            "start": round(seg.start, 3), "end": round(seg.end, 3), "text": seg.text.strip(),
            "words": [{"start": round(w.start, 3), "end": round(w.end, 3), "word": w.word} for w in (seg.words or [])],
        })
    return {"language": info.language, "segments": result}


def transcribe_openai(path: str, model_name: str) -> dict:
    import whisper

    model = whisper.load_model(model_name)
    output = model.transcribe(path, word_timestamps=True)
    result = []
    for seg in output["segments"]:
        if seg.get("no_speech_prob", 0) > 0.6 or not seg["text"].strip():
            continue
        result.append({
            "start": round(seg["start"], 3), "end": round(seg["end"], 3), "text": seg["text"].strip(),
            "words": [{"start": round(w["start"], 3), "end": round(w["end"], 3), "word": w["word"]} for w in seg.get("words", [])],
        })
    return {"language": output.get("language"), "segments": result}


def main() -> int:
    source, target = sys.argv[1], sys.argv[2]
    model_name = os.environ.get("NEARFIELD_WHISPER", "small")
    try:
        data = transcribe_faster(source, model_name)
    except ImportError:
        try:
            data = transcribe_openai(source, model_name)
        except ImportError:
            print("NO_WHISPER", file=sys.stderr)
            return 3
    with open(target, "w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
