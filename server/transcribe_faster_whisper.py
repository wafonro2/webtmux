#!/usr/bin/env python3
import argparse
import json
import sys


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Transcribe audio with faster-whisper.")
    parser.add_argument("--input", required=True, help="Path to input audio file")
    parser.add_argument("--model", default="large-v3-turbo", help="faster-whisper model name/path")
    parser.add_argument("--device", default="auto", help="Device: auto/cuda/cpu")
    parser.add_argument(
        "--compute-type",
        default="float16",
        help="Compute type, for example: float16, int8_float16, int8",
    )
    parser.add_argument("--language", default=None, help="Optional language code, e.g. en, pt")
    parser.add_argument("--beam-size", default=1, type=int, help="Beam size")
    parser.add_argument("--vad-filter", default=1, type=int, help="Enable VAD filter (1/0)")
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    try:
        from faster_whisper import WhisperModel
    except Exception as exc:  # pragma: no cover
        print(
            json.dumps({"error": f"Failed to import faster_whisper: {exc}"}),
            file=sys.stderr,
        )
        return 2

    try:
        model = WhisperModel(
            args.model,
            device=args.device,
            compute_type=args.compute_type,
        )
        segments, _info = model.transcribe(
            args.input,
            language=args.language,
            beam_size=max(1, int(args.beam_size)),
            vad_filter=bool(args.vad_filter),
        )

        parts = []
        for segment in segments:
            text = (segment.text or "").strip()
            if text:
                parts.append(text)

        output = {"text": " ".join(parts).strip()}
        print(json.dumps(output, ensure_ascii=False))
        return 0
    except Exception as exc:  # pragma: no cover
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
