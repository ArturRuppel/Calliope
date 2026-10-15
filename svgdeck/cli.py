"""svgdeck command line: serve, export, pdf."""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

DEFAULT_DATA = Path(os.environ.get("SVGDECK_DATA", "~/Data/svgdeck")).expanduser()


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="svgdeck")
    sub = parser.add_subparsers(dest="command", required=True)

    serve = sub.add_parser("serve", help="run the svgdeck service")
    serve.add_argument("--data", type=Path, default=DEFAULT_DATA,
                       help=f"data directory holding decks/ (default {DEFAULT_DATA}, or $SVGDECK_DATA)")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8490)

    exp = sub.add_parser("export", help="write a standalone offline copy of a deck")
    exp.add_argument("deck", type=Path, help="deck directory")
    exp.add_argument("out", type=Path, help="output directory (replaced if it is an earlier export)")
    exp.add_argument("--zip", type=Path, help="also write the export as this zip file")
    exp.add_argument("--pdf", action="store_true",
                     help="also write deck.pdf into the export (and the zip); needs svgdeck[pdf]")

    pdf = sub.add_parser("pdf", help="print a deck to PDF, one page per slide (needs svgdeck[pdf])")
    pdf.add_argument("deck", type=Path, help="deck directory")
    pdf.add_argument("out", type=Path, help="PDF file to write")
    pdf.add_argument("--steps", action="store_true", help="one page per build step instead of per slide")

    args = parser.parse_args(argv)
    if args.command == "serve":
        import uvicorn
        from .server import create_app
        uvicorn.run(create_app(args.data), host=args.host, port=args.port)
    elif args.command == "export":
        from .deck import Deck
        from .export import export
        try:
            out = export(Deck.load(args.deck), args.out, args.zip, pdf=args.pdf)
        except RuntimeError as error:  # PDF export without Playwright or Chromium
            sys.exit(f"svgdeck: {error}")
        print(f"exported to {out}/index.html" + (f", {out}/deck.pdf" if args.pdf else "")
              + (f" and {args.zip}" if args.zip else ""))
    elif args.command == "pdf":
        from .pdf import render_pdf
        try:
            out = render_pdf(args.deck, args.out, steps=args.steps)
        except RuntimeError as error:
            sys.exit(f"svgdeck: {error}")
        print(f"wrote {out}")


if __name__ == "__main__":
    main()
