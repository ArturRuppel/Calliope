"""svgdeck command line: serve, export."""
from __future__ import annotations

import argparse
import os
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

    exp.add_argument("--no-notes", action="store_true", help="leave speaker notes out of the export")

    args = parser.parse_args(argv)
    if args.command == "serve":
        import uvicorn
        from .server import create_app
        uvicorn.run(create_app(args.data), host=args.host, port=args.port)
    elif args.command == "export":
        from .deck import Deck
        from .export import export
        out = export(Deck.load(args.deck), args.out, args.zip, include_notes=not args.no_notes)
        print(f"exported to {out}/index.html" + (f" and {args.zip}" if args.zip else ""))


if __name__ == "__main__":
    main()
