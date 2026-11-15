# Plugin download regression tests

These standard-library Python tests extract only the program files from the released 1.1.5 ZIP and use an isolated local HTTP server and temporary task database. No live API keys, external generation or real user files are used.

Run from the repository root with Python 3.12:

```sh
python -m unittest discover -s tests/plugin_download -p test_resume_download.py -v
```

The suite includes the base generation/recovery regression cases and download fault injection. It verifies original task IDs, one generation POST per output slot, complete file bytes, correct host output paths, no leftover fragments, download-only recovery and cross-origin credential isolation.
